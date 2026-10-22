import {randomUUID} from 'node:crypto';
import {getStore} from '@netlify/blobs';
import type {SqlPool} from './postgres-storage';

export interface WakeValue {version:1;revision:string;nextAt:number|null;lastTick:number|null}
export interface WakeSnapshot {value:WakeValue;etag:string}
export interface WakeStore {
 read():Promise<WakeSnapshot|null>;
 write(value:WakeValue,etag:string|null):Promise<boolean>;
}
export function netlifyWakeStore():WakeStore {
 // Site-wide store deliberately survives deployments. Never use getDeployStore.
 const store=()=>getStore({name:'campus-reminders-production-v1',consistency:'strong'}),key='wake';
 return{
  async read(){const result=await store().getWithMetadata(key,{type:'json',consistency:'strong'});if(!result)return null;
   const value=result.data as WakeValue;
   if(value?.version!==1||typeof value.revision!=='string'||![value.nextAt,value.lastTick].every(n=>n===null||typeof n==='number'&&Number.isFinite(n)))throw Error('Invalid reminder index');
   if(!result.etag)throw Error('Reminder index has no ETag');
   return{value,etag:result.etag};
  },
  async write(value,etag){const result=await store().setJSON(key,value,etag?{onlyIfMatch:etag}:{onlyIfNew:true});return result.modified;}
 };
}
export async function replaceWake(store:WakeStore,before:WakeSnapshot|null,nextAt:number|null,lastTick=before?.value.lastTick??null){
 const value:WakeValue={version:1,revision:randomUUID(),nextAt,lastTick};
 try{if(!await store.write(value,before?.etag??null))return false;}
 catch{
  // An interrupted write can have committed. Verify strongly before reporting success.
  const read=await store.read();if(read?.value.revision===value.revision)return true;throw Error('Reminder index write was not confirmed');
 }
 const read=await store.read();return read?.value.revision===value.revision;
}
export async function refreshWake(pool:SqlPool,store:WakeStore,now=Date.now(),includeFeedback=false){
 for(let attempt=0;attempt<8;attempt++){
  // Read the CAS version BEFORE SQL. A concurrent save which registered an
  // earlier task changes this ETag and prevents overwriting it with a later date.
  const before=await store.read();
  const {rows}=await pool.query(`SELECT min(next_at) AS next_at FROM (
   SELECT CASE WHEN state='processing' THEN lease_until ELSE greatest(run_at,retry_at) END AS next_at
    FROM campus_reminder_jobs WHERE provider='aliyun-fc' AND state IN ('pending','processing')
   UNION ALL SELECT feedback_due_at AS next_at FROM campus_reminder_email
    WHERE $1::boolean AND enabled=true AND verified_at IS NOT NULL AND suspended=false AND feedback_due_at IS NOT NULL
   ) due`,[includeFeedback]);
  const nextAt=rows[0]?.next_at?Date.parse(rows[0].next_at):null;
  if(!await replaceWake(store,before,nextAt))continue;
  // Only mark rows actually covered by the confirmed wake-up. A later SQL
  // commit with an earlier deadline cannot be incorrectly marked registered.
  if(nextAt!==null)await pool.query(`UPDATE campus_reminder_jobs SET registered_at=$2,registration_error=NULL
   WHERE provider='aliyun-fc' AND state='pending' AND greatest(run_at,retry_at)>=$1`,[new Date(nextAt).toISOString(),new Date(now).toISOString()]);
  return;
 }
 throw Error('Reminder index has concurrent updates');
}
export async function minuteTick(options:{store:WakeStore;process:()=>Promise<unknown>;now?:()=>number}){
 const now=(options.now||Date.now)(),before=await options.store.read();
 if(!before)throw Error('Reminder index missing; bounded repair required');
 if(before.value.nextAt!==null&&before.value.nextAt<=now){
  if(before.value.lastTick===null||now-before.value.lastTick>=300000)await replaceWake(options.store,before,before.value.nextAt,now);
  return options.process();
 }
 // Empty ticks never instantiate a database client. Health is written at most
 // every five minutes; a conditional update cannot erase a concurrent save.
 if(before.value.lastTick===null||now-before.value.lastTick>=300000)await replaceWake(options.store,before,before.value.nextAt,now);
 return{idle:true};
}
