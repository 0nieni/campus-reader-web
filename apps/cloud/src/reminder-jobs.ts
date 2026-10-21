import {randomUUID} from 'node:crypto';
import type {Reminder,ReminderDelivery} from '@campus/contracts';
import type {SqlExecutor,SqlPool,Row} from './postgres-storage';
export const reminderWindow=6*86400000;
export interface ReminderPublisher {publish(jobId:string,at:number):Promise<string>}
type VersionedReminder=Reminder&{generation:string};
const uuid=()=>randomUUID().replace(/-/g,'');
const iso=(time:number)=>new Date(time).toISOString();

// Called inside the same transaction that saves the account. A failed enqueue
// can never erase the task, and cancel/edit invalidates its old generation.
export async function syncReminderJobs(sql:SqlExecutor,owner:string,reminders:VersionedReminder[],time:number,provider:'qstash'|'aliyun-fc'='qstash'){
 const records:{id:string;reminder_id:string;generation:string;offset_days:number;run_at:string}[]=[];
 for(const reminder of reminders){
  if(!reminder.dueAt)continue;
  for(const offset of reminder.days){
   const at=Date.parse(reminder.dueAt)-offset*86400000;if(at<=time)continue;
   records.push({id:uuid(),reminder_id:reminder.id,generation:reminder.generation,offset_days:offset,run_at:iso(at)});
  }
 }
 if(records.length)await sql.query(`INSERT INTO campus_reminder_jobs(id,owner_id,reminder_id,generation,offset_days,run_at,created_at,updated_at,provider)
  SELECT r.id,$1,r.reminder_id,r.generation,r.offset_days,r.run_at::timestamptz,$3,$3,$4 FROM jsonb_to_recordset($2::jsonb)
   AS r(id text,reminder_id text,generation text,offset_days integer,run_at text)
  ON CONFLICT(owner_id,reminder_id,generation,offset_days) DO NOTHING`,[owner,JSON.stringify(records),iso(time),provider]);
 if(provider==='aliyun-fc')await sql.query(`UPDATE campus_reminder_jobs SET provider='aliyun-fc',state='pending',lease_id=NULL,lease_until=NULL,registered_at=NULL,registration_error=NULL,retry_at='1970-01-01T00:00:00Z',updated_at=$2
  WHERE owner_id=$1 AND provider='qstash' AND run_at>$2 AND state IN ('pending','registering','queued')`,[owner,iso(time)]);
 await sql.query(`UPDATE campus_reminder_jobs j SET state='cancelled',updated_at=$3 WHERE owner_id=$1 AND state IN ('pending','registering','queued')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($2::jsonb) r WHERE r->>'id'=j.reminder_id AND r->>'generation'=j.generation AND r->'days' @> to_jsonb(j.offset_days))`,[owner,JSON.stringify(reminders),iso(time)]);
}

async function claim(pool:SqlPool,owner:string|undefined,time:number):Promise<Row|null>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const {rows}=await client.query(`SELECT j.* FROM campus_reminder_jobs j
   WHERE ($1::text IS NULL OR j.owner_id=$1) AND (j.state='pending' OR (j.state='registering' AND j.lease_until<$2))
   AND j.run_at<=$3 AND j.run_at>=$4 AND j.retry_at<=$2
   AND EXISTS(SELECT 1 FROM campus_push_devices d WHERE d.owner_id=j.owner_id AND d.updated_at<=j.run_at)
   ORDER BY j.run_at,j.id LIMIT 1 FOR UPDATE SKIP LOCKED`,[owner||null,iso(time),iso(time+reminderWindow),iso(time-86400000)]);
  const row=rows[0];if(!row){await client.query('COMMIT');return null;}
  // Reserve conservatively by delivery date, not publication date. Cancelled
  // and uncertain publications retain their reservation. Other apps' QStash
  // usage and retries crossing midnight still require account-level monitoring.
  const date=iso(Math.max(time,Date.parse(row.run_at))).slice(0,10);
  const budget=await client.query(`INSERT INTO campus_reminder_queue_budget(day,used) VALUES($1,1)
   ON CONFLICT(day) DO UPDATE SET used=campus_reminder_queue_budget.used+1 WHERE campus_reminder_queue_budget.used<400 RETURNING used`,[date]);
  if(!budget.rows.length){
   await client.query("UPDATE campus_reminder_jobs SET registration_error='quota',retry_at=$2,updated_at=$3 WHERE id=$1",[row.id,iso(time+3600000),iso(time)]);
   await client.query('COMMIT');return null;
  }
  const lease=uuid();
  await client.query("UPDATE campus_reminder_jobs SET state='registering',lease_id=$2,lease_until=$3,attempts=attempts+1,updated_at=$4 WHERE id=$1",[row.id,lease,iso(time+120000),iso(time)]);
  await client.query('COMMIT');return{...row,lease_id:lease};
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
export async function flushReminderJobs(pool:SqlPool,publisher:ReminderPublisher,options:{owner?:string;now?:()=>number;limit?:number;budgetMs?:number}={}){
 const now=options.now||Date.now,start=Date.now();let queued=0,failed=0;
 // Bound both foreground latency and scheduled-function execution time.
 for(let i=0;i<(options.limit??4)&&Date.now()-start<(options.budgetMs??4000);i++){
  const row=await claim(pool,options.owner,now());if(!row)break;
  try{
   const message=await publisher.publish(row.id,Math.max(now(),Date.parse(row.run_at)));
   await pool.query("UPDATE campus_reminder_jobs SET state='queued',message_id=$3,registration_error=NULL,lease_until=NULL,updated_at=$4 WHERE id=$1 AND lease_id=$2 AND state='registering'",[row.id,row.lease_id,message,iso(now())]);queued++;
  }catch{
   await pool.query("UPDATE campus_reminder_jobs SET state='pending',registration_error='publish_failed',retry_at=$3,lease_until=NULL,updated_at=$4 WHERE id=$1 AND lease_id=$2 AND state='registering'",[row.id,row.lease_id,iso(now()+300000),iso(now())]);failed++;
  }
 }
 return{queued,failed};
}
export async function reminderDeliveryState(sql:SqlExecutor,owner:string,reminders:Reminder[],configured:boolean,push:boolean,time:number){
 const devices=await sql.query('SELECT count(*)::integer AS count FROM campus_push_devices WHERE owner_id=$1',[owner]);
 const deviceCount=Number(devices.rows[0]?.count||0);
 const {rows}=await sql.query(`SELECT j.reminder_id,j.run_at,j.state,j.outcome,j.registration_error FROM campus_reminder_jobs j
  JOIN campus_reminder_accounts a ON a.owner_id=j.owner_id WHERE j.owner_id=$1 AND j.state NOT IN ('cancelled','expired')
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.body->'reminders') r WHERE r->>'id'=j.reminder_id AND r->>'generation'=j.generation)
  ORDER BY j.run_at`,[owner]);
 return{deviceCount,reminders:reminders.map(reminder=>{
  const jobs=rows.filter(row=>row.reminder_id===reminder.id),upcoming=jobs.find(row=>Date.parse(row.run_at)>time),recent=jobs.filter(row=>Date.parse(row.run_at)<=time).at(-1);
  let status:ReminderDelivery['status']='pending';
  if(!push||!configured)status='unconfigured';
  else if(!deviceCount)status='no_device';
  else if(recent?.registration_error||upcoming?.registration_error)status='registration_failed';
  else if(recent&&recent.state!=='complete'&&time-Date.parse(recent.run_at)>120000)status='unknown';
  else if(recent?.outcome==='unknown'||recent?.outcome==='failed')status=recent.outcome;
  else if(upcoming?.state==='queued')status='scheduled';
  else if(upcoming&&Date.parse(upcoming.run_at)>time+reminderWindow)status='later';
  else if(recent?.outcome==='sent')status='sent';
  else if(!upcoming&&recent?.state==='complete')status='finished';
  else if(!jobs.length&&reminder.dueAt&&reminder.days.every(offset=>Date.parse(reminder.dueAt!)-offset*86400000<=time))status='finished';
  return{...reminder,delivery:{status,nextAt:upcoming?iso(Date.parse(upcoming.run_at)):null} as ReminderDelivery};
 })};
}
