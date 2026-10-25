import {createHash,randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import type {SqlPool} from './postgres-storage';
import type {ItemRow} from './repository';
import {AppError} from './errors';
import {competitionSources} from './competition-sources';
const iso=(at:number)=>new Date(at).toISOString();
export const MATERIAL_JOB_PATH='/.netlify/functions/material-collect-background';
export function jobSignature(secret:string,at:string,body:string){return createHmac('sha256',secret).update(`POST\n${MATERIAL_JOB_PATH}\n${at}\n${body}`).digest('hex');}
export function validJob(secret:string|undefined,at:string|null,body:string,signature:string|null,now=Date.now()){
 if(!secret||secret.length<32||!at||!/^\d{13}$/.test(at)||Math.abs(now-Number(at))>300000||!signature||!/^[a-f0-9]{64}$/.test(signature))return false;
 return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(jobSignature(secret,at,body),'hex'));
}
export function materialJobs(pool:SqlPool,actions:{school(id:string):Promise<unknown>;source(id:string,owner:string,school:string):Promise<unknown>;material(row:ItemRow,deadline:number):Promise<unknown>;cleanup():Promise<{expired:number;deleted:number;more?:boolean}>},now=Date.now){
 async function enqueue(day:string,kind:string,school:string,owner:string,target:string){
  const id=createHash('sha256').update([day,kind,school,owner,target].join('\n')).digest('hex');
  await pool.query('INSERT INTO campus_collection_jobs(id,run_day,kind,school_id,owner_key,target_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[id,day,kind,school,owner,target]);
 }
 async function start(){
  const day=iso(now()+8*3600000).slice(0,10);
  const schools=await pool.query("SELECT id FROM campus_documents WHERE collection='school_sync' AND body->>'lastVisitedAt'>=$1 AND id NOT LIKE '__website_%' ORDER BY id",[iso(now()-30*86400000)]);
  for(const row of schools.rows)await enqueue(day,'school',row.id,'',row.id);
  const sources=await pool.query("SELECT id,body FROM campus_documents WHERE collection='sources' AND body->>'importKind'='website' AND body->>'deleted' IS DISTINCT FROM 'true' AND body->>'enabled' IS DISTINCT FROM 'false' ORDER BY id");
  for(const row of sources.rows)if(row.body.ownerOpenid&&row.body.schoolIds?.[0])await enqueue(day,'source',row.body.schoolIds[0],row.body.ownerOpenid,row.id);
  const profiles=await pool.query("SELECT body->'sourceFeedVisibility' AS choices FROM campus_documents WHERE collection='user_profiles' AND body ? 'sourceFeedVisibility'");
  const optedIn=new Set<string>();
  for(const row of profiles.rows)if(row.choices&&typeof row.choices==='object'&&!Array.isArray(row.choices))for(const choices of Object.values(row.choices))if(choices&&typeof choices==='object'&&!Array.isArray(choices))for(const [id,value] of Object.entries(choices))if(value===true&&competitionSources.some(source=>source.id===id))optedIn.add(id);
  for(const id of optedIn)await enqueue(day,'source','global','',id);
  await pool.query("DELETE FROM campus_collection_jobs WHERE run_day<$1::date-31 AND lease_until<=$2",[day,iso(now())]);
 }
 async function run(deadline:number){
  const totals={complete:0,failed:0,expired:0,deleted:0};
  let cleanupMore=false;
  for(let i=0;i<20&&now()<deadline-30000;i++){const result=await actions.cleanup();totals.expired+=result.expired;totals.deleted+=result.deleted;cleanupMore=Boolean(result.more);if(!result.expired&&!result.deleted&&!cleanupMore)break;}
  while(now()<deadline-60000){
   const token=randomUUID();
   const claimed=await pool.query(`UPDATE campus_collection_jobs SET state='running',attempts=attempts+1,lease_id=$1,lease_until=$2,updated_at=$3 WHERE id=(SELECT id FROM campus_collection_jobs WHERE attempts<3 AND (state='pending' OR (state='running' AND lease_until<=$3)) ORDER BY run_day,CASE kind WHEN 'school' THEN 0 WHEN 'source' THEN 1 ELSE 2 END,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *,run_day::text AS run_date`,[token,iso(now()+14*60000),iso(now())]);
   const job=claimed.rows[0];if(!job)break;
   try{
    if(job.kind==='school')await actions.school(job.school_id);
    if(job.kind==='source')await actions.source(job.target_id,job.owner_key,job.school_id);
    if(job.kind==='item'){
     const row=(await pool.query("SELECT body FROM campus_documents WHERE collection='items' AND id=$1",[job.target_id])).rows[0]?.body;
     if(row&&String(row.ownerOpenid||'')===job.owner_key){
      const result=await actions.material({...row,_id:job.target_id},deadline-20000);
      if(result&&typeof result==='object'&&'materialPending' in result&&result.materialPending)throw new AppError('MATERIAL_PENDING','附件待下次后台继续。');
     }
    }else{
     const rows=await pool.query(`SELECT i.id,i.body,s.body->>'key' AS source_key FROM campus_documents i JOIN campus_documents s ON s.collection='sources' AND s.id=i.body->>'sourceId' WHERE i.collection='items' AND i.body->>'status'='published' AND i.body->>'aiSearchExpiresAt' IS NULL AND coalesce(i.body->>'ownerOpenid','')=$1 AND (i.body->'schoolIds' ? $2 OR ($1='' AND (i.body->>'scope'='global' OR (NOT(i.body ? 'scope') AND (s.body->>'key' IN ('ciscn-announcement','lanqiao-competition') OR ($2='bjtu' AND s.body->>'key' IN ('bjtu-bksy','bjtu-tzgg','bjtu-cs-tzgg'))))))) AND ($3='school' OR i.body->>'sourceId'=$4) AND s.body->>'enabled' IS DISTINCT FROM 'false' AND s.body->>'deleted' IS DISTINCT FROM 'true' AND coalesce(nullif(i.body->>'publishedAt',''),nullif(i.body->>'discoveredAt',''),i.body->>'createdAt')>=$5 ORDER BY i.id`,[job.owner_key,job.school_id,job.kind,job.target_id,iso(now()-365*86400000)]);
     const day=job.run_date as string;
     for(const row of rows.rows)if(row.body.originalUrl)await enqueue(day,'item',row.body.scope==='global'||['ciscn-announcement','lanqiao-competition'].includes(row.source_key)?'global':job.school_id,job.owner_key,row.id);
    }
    await pool.query("UPDATE campus_collection_jobs SET state='complete',message='',lease_id=NULL,lease_until=$3,updated_at=$3 WHERE id=$1 AND lease_id=$2",[job.id,token,iso(now())]);totals.complete++;
   }catch(error){
    // Safe public code only; no URLs, file content, credentials or owner IDs in logs.
    const code=error instanceof AppError?error.code:'COLLECTION_FAILED';
    await pool.query("UPDATE campus_collection_jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,message=$3,lease_id=NULL,lease_until=$4,updated_at=$4 WHERE id=$1 AND lease_id=$2",[job.id,token,code,iso(now())]);totals.failed++;
   }
  }
  // A worker killed during its third attempt must not remain running forever.
  await pool.query("UPDATE campus_collection_jobs SET state='failed',lease_id=NULL WHERE attempts>=3 AND state='running' AND lease_until<=$1",[iso(now())]);
  const more=await pool.query("SELECT id FROM campus_collection_jobs WHERE attempts<3 AND (state='pending' OR (state='running' AND lease_until<=$1)) LIMIT 1",[iso(now())]);
  return{...totals,more:cleanupMore||more.rows.length>0};
 }
 return{start,run};
}
