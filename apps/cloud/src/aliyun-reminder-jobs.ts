import {randomUUID} from 'node:crypto';
import type {Reminder,ReminderChannelDelivery,ReminderState} from '@campus/contracts';
import type {SqlClient,SqlPool,Row} from './postgres-storage';
import {checkedSubscription,sendBrowserPush,type PushConfig} from './browser-push';
import {reminderEmail,reserveEmail,reminderOrigin} from './reminder-email';
import {refreshWake,type WakeStore} from './reminder-index';
import type {MailResult} from './directmail';
type Stored=Reminder&{generation:string};
export interface AliyunOptions {index?:WakeStore;email?:ReturnType<typeof reminderEmail>}
type Revalidate=<T>(owner:string,run:(client:SqlClient,reminders:Stored[])=>Promise<T>)=>Promise<T>;
const iso=(n:number)=>new Date(n).toISOString();
const channel=(r:Reminder)=>r.channels||{browser:true,email:false};
export function aliyunJobs(pool:SqlPool,options:AliyunOptions&{now?:()=>number;push?:PushConfig;send?:typeof sendBrowserPush},revalidate:Revalidate){
 const now=options.now||Date.now,send=options.send||sendBrowserPush;
 async function register(){
  if(!options.index)return false;
  try{await refreshWake(pool,options.index,now(),Boolean(options.email?.sender?.suppressed));return true;}catch{return false;}
 }
 async function claim():Promise<Row|undefined>{
  const client=await pool.connect();try{
   await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='6000'");
   const {rows}=await client.query(`SELECT a.owner_id FROM campus_reminder_accounts a WHERE EXISTS(SELECT 1 FROM campus_reminder_jobs j
    WHERE j.owner_id=a.owner_id AND provider='aliyun-fc' AND ((j.state='pending' AND greatest(j.run_at,j.retry_at)<=$1) OR (j.state='processing' AND j.lease_until<=$1)))
    ORDER BY a.queue_checked_at,a.owner_id LIMIT 1 FOR UPDATE OF a SKIP LOCKED`,[iso(now())]);
   if(!rows.length){await client.query('COMMIT');return;}
   const owner=rows[0].owner_id,task=await client.query(`SELECT * FROM campus_reminder_jobs WHERE owner_id=$1 AND provider='aliyun-fc'
    AND ((state='pending' AND greatest(run_at,retry_at)<=$2) OR (state='processing' AND lease_until<=$2)) ORDER BY run_at,id LIMIT 1 FOR UPDATE`,[owner,iso(now())]);
   const job=task.rows[0];if(!job){await client.query('COMMIT');return;}
   // Claims made before an interrupted request remain unknown; never resend a
   // channel which might already have reached its external provider.
   await client.query("UPDATE campus_reminder_channel_receipts SET state='unknown',code='interrupted',finished_at=$2 WHERE job_id=$1 AND state='sending'",[job.id,iso(now())]);
   const lease=randomUUID();
   await client.query("UPDATE campus_reminder_jobs SET state='processing',lease_id=$2,lease_until=$3,attempts=attempts+1,updated_at=$4 WHERE id=$1",[job.id,lease,iso(now()+90000),iso(now())]);
   await client.query('UPDATE campus_reminder_accounts SET queue_checked_at=$2 WHERE owner_id=$1',[owner,iso(now())]);await client.query('COMMIT');return{...job,lease_id:lease};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 }
 const valid=(reminders:Stored[],job:Row)=>{
  const r=reminders.find(r=>r.id===job.reminder_id&&r.generation===job.generation),time=now(),at=Date.parse(job.run_at);
  if(!r?.dueAt||at>time||time-at>86400000)return;
  const crossed=r.days.filter(n=>Date.parse(r.dueAt!)-n*86400000<=time);return crossed.length&&job.offset_days===Math.min(...crossed)?r:undefined;
 };
 async function run(job:Row){
  let email:Row|undefined,identityFailed=false;
  const account=await pool.query('SELECT body FROM campus_reminder_accounts WHERE owner_id=$1',[job.owner_id]);
  const needsEmail=Boolean((account.rows[0]?.body.reminders as Stored[]|undefined)?.find(r=>r.id===job.reminder_id&&r.generation===job.generation)?.channels?.email);
  if(needsEmail&&options.email?.sender)try{email=await options.email.current(job.owner_id);}catch{identityFailed=true;}
  const targets=await revalidate(job.owner_id,async(client,reminders)=>{
   const r=valid(reminders,job),found=await client.query('SELECT state,lease_id FROM campus_reminder_jobs WHERE id=$1',[job.id]);
   if(!r||found.rows[0]?.lease_id!==job.lease_id||found.rows[0]?.state!=='processing')return[];
   const candidates:{channel:'browser'|'email';target:string;binding:string;subscription?:unknown;address?:string}[]=[];
   if(channel(r).browser&&options.push){
    const devices=await client.query('SELECT endpoint_hash,binding_id,subscription FROM campus_push_devices WHERE owner_id=$1 AND updated_at<=$2',[job.owner_id,job.run_at]);
    for(const row of devices.rows)candidates.push({channel:'browser',target:row.endpoint_hash,binding:row.binding_id,subscription:row.subscription});
   }
   if(channel(r).email&&options.email?.sender&&email?.enabled&&email.verified_at&&!email.suspended&&Date.parse(email.enabled_at)<=Date.parse(job.run_at)&&Date.parse(email.verified_at)<=Date.parse(job.run_at))candidates.push({channel:'email',target:'account',binding:email.binding_id,address:email.email});
   const targets=[];
   for(const candidate of candidates){
    const receipt=await client.query(`INSERT INTO campus_reminder_channel_receipts(job_id,channel,target_id,binding_id,state,created_at) VALUES($1,$2,$3,$4,'ready',$5)
     ON CONFLICT(job_id,channel,target_id,binding_id) DO UPDATE SET state='ready',attempts=campus_reminder_channel_receipts.attempts+1
      WHERE campus_reminder_channel_receipts.state IN ('temporary','limited') AND campus_reminder_channel_receipts.retry_at<=$5 AND campus_reminder_channel_receipts.attempts<3
     RETURNING attempts`,[job.id,candidate.channel,candidate.target,candidate.binding,iso(now())]);
    if(receipt.rows.length)targets.push({...candidate,attempts:Number(receipt.rows[0].attempts)});
   }
   return targets;
  });
  let accepted=0,failed=0;
  await Promise.all(targets.map(async target=>{
   let result:MailResult={state:'failed',code:'cancelled'},skipped=false,attempted=false;
   try{
    if(target.channel==='email'){
     try{email=await options.email!.current(job.owner_id,target.binding);}catch{email=undefined;throw Error('identity_unavailable');}
    }
    const allowed=await revalidate(job.owner_id,async(client,reminders)=>{
     const r=valid(reminders,job);if(!r||!channel(r)[target.channel])return false;
     const task=await client.query("SELECT id FROM campus_reminder_jobs WHERE id=$1 AND lease_id=$2 AND provider='aliyun-fc' AND state='processing'",[job.id,job.lease_id]);if(!task.rows.length)return false;
     if(target.channel==='browser'){
      const device=await client.query('SELECT endpoint_hash FROM campus_push_devices WHERE owner_id=$1 AND endpoint_hash=$2 AND binding_id=$3',[job.owner_id,target.target,target.binding]);if(!device.rows.length)return false;
     }else{
      if(!email||!email.enabled||!email.verified_at||email.suspended||email.binding_id!==target.binding)return false;
      const latest=await client.query('SELECT binding_id FROM campus_reminder_email WHERE owner_id=$1 AND binding_id=$2 AND enabled=true AND suspended=false AND verified_at IS NOT NULL',[job.owner_id,target.binding]);if(!latest.rows.length)return false;
      await reserveEmail(client,job.owner_id,'reminder',now(),options.email!.dailyLimit);
     }
     await client.query("UPDATE campus_reminder_channel_receipts SET state='sending',started_at=$5 WHERE job_id=$1 AND channel=$2 AND target_id=$3 AND binding_id=$4 AND state='ready'",[job.id,target.channel,target.target,target.binding,iso(now())]);return true;
    });
    if(!allowed){skipped=true;}
    else if(target.channel==='browser'){
     attempted=true;
     try{await send(checkedSubscription(target.subscription),options.push!,job.id);result={state:'accepted'};}
     catch(error){const status=Number((error as {statusCode?:number})?.statusCode);result={state:!status?'unknown':[429,502,503,504].includes(status)?'temporary':'failed',code:!status?'network_unknown':'provider_rejected',invalid:[404,410].includes(status)};}
    }else{
     const unsubscribe=await options.email!.unsubscribeLink(job.owner_id,target.binding);
     if(!unsubscribe){skipped=true;}else{attempted=true;result=await options.email!.sender!.send(target.address!,'校园阅览室｜你有一条到期提醒',`你设置的事项已到提醒时间。\n提醒时间：${new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'short'}).format(new Date(job.run_at))}（北京时间）\n登录查看：${reminderOrigin}/?view=reminders\n关闭邮件：${unsubscribe}\n邮件不包含公告标题、正文或 AI 摘要。`);}
    }
   }catch(error){result={state:attempted?'unknown':'temporary',code:attempted?'network_unknown':(error as {code?:string})?.code==='EMAIL_LIMIT'?'quota':'before_send_failed'};}
   let state=skipped?'skipped':result.state,retryAt:string|null=null;
   if(state==='temporary'){
    if(target.attempts>=3||now()-Date.parse(job.run_at)>23*3600000)state=result.code==='quota'?'limited':'failed';
    else{state=result.code==='quota'?'limited':'temporary';retryAt=iso(now()+(result.code==='quota'?3600000:60000*2**(target.attempts-1)));}
   }
   if(result.state==='accepted')accepted++;else if(!skipped)failed++;
   await pool.query(`UPDATE campus_reminder_channel_receipts SET state=$5,provider_id=$6,code=$7,retry_at=$8,finished_at=$9
    WHERE job_id=$1 AND channel=$2 AND target_id=$3 AND binding_id=$4`,[job.id,target.channel,target.target,target.binding,state,result.id||null,result.code||null,retryAt,iso(now())]);
   if(target.channel==='email'&&result.state==='accepted')await options.email!.noteAccepted(job.owner_id,target.binding);
   if(result.invalid){
    if(target.channel==='browser')await pool.query('DELETE FROM campus_push_devices WHERE owner_id=$1 AND endpoint_hash=$2 AND binding_id=$3',[job.owner_id,target.target,target.binding]);
    else await options.email!.suspend(job.owner_id,target.binding);
   }
  }));
  const receipts=await pool.query('SELECT state,retry_at FROM campus_reminder_channel_receipts WHERE job_id=$1',[job.id]);
  const retries=receipts.rows.filter(r=>['temporary','limited'].includes(r.state)&&r.retry_at),unknown=receipts.rows.some(r=>['sending','unknown','ready'].includes(r.state));
  let retryAt=retries.length?Math.min(...retries.map(r=>Date.parse(r.retry_at))):null;
  // Identity service failure occurs before an email request. Retry within the
  // compensation window even if the independent browser channel has finished.
  if(identityFailed&&Number(job.attempts)<3&&now()-Date.parse(job.run_at)<23*3600000)retryAt=Math.min(retryAt??Infinity,now()+300000);
  const outcome=unknown?'unknown':identityFailed||receipts.rows.some(r=>r.state==='failed')?'failed':receipts.rows.some(r=>r.state==='accepted')?'sent':'skipped';
  await pool.query(`UPDATE campus_reminder_jobs SET state=$3,outcome=$4,retry_at=$5,lease_until=NULL,updated_at=$6 WHERE id=$1 AND lease_id=$2 AND state='processing'`,[job.id,job.lease_id,retryAt===null?'complete':'pending',outcome,retryAt===null?iso(now()):iso(retryAt),iso(now())]);
  return{accepted,failed};
 }
 async function tick(optionsTick:{limit?:number;budgetMs?:number}={}){
  const start=Date.now();let processed=0,accepted=0,failed=0;
  while(processed<(optionsTick.limit??100)&&Date.now()-start<(optionsTick.budgetMs??18000)-6500){
   const jobs=[];for(let i=0;i<Math.min(4,(optionsTick.limit??100)-processed);i++){const job=await claim();if(!job)break;jobs.push(job);}if(!jobs.length)break;
   const results=await Promise.allSettled(jobs.map(run));for(const result of results){processed++;if(result.status==='fulfilled'){accepted+=result.value.accepted;failed+=result.value.failed;}else failed++;}
  }
  if(Date.now()-start<(optionsTick.budgetMs??18000)-6500)await options.email?.feedback(4,true);
  if(options.index)await refreshWake(pool,options.index,now(),Boolean(options.email?.sender?.suppressed));
  console.info(JSON.stringify({event:'aliyun-reminders',processed,accepted,failed,elapsedMs:Date.now()-start}));return{processed,accepted,failed};
 }
 async function decorate(owner:string,state:ReminderState,registered=true):Promise<ReminderState>{
  const devices=await pool.query('SELECT count(*)::integer AS count FROM campus_push_devices WHERE owner_id=$1',[owner]),deviceCount=Number(devices.rows[0]?.count||0);
  const email=await options.email?.state(owner),{rows}=await pool.query(`SELECT j.*,coalesce((SELECT jsonb_agg(jsonb_build_object('channel',r.channel,'state',r.state)) FROM campus_reminder_channel_receipts r WHERE r.job_id=j.id),'[]'::jsonb) AS receipts
   FROM campus_reminder_jobs j JOIN campus_reminder_accounts a ON a.owner_id=j.owner_id WHERE j.owner_id=$1 AND provider='aliyun-fc' AND state NOT IN ('cancelled','expired')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.body->'reminders') r WHERE r->>'id'=j.reminder_id AND r->>'generation'=j.generation) ORDER BY run_at`,[owner]);
  const reminders=state.reminders.map(reminder=>{
   const jobs=rows.filter(row=>row.reminder_id===reminder.id),upcoming=jobs.find(j=>Date.parse(j.run_at)>now()),recent=jobs.filter(j=>Date.parse(j.run_at)<=now()).at(-1);
   function status(kind:'browser'|'email'):ReminderChannelDelivery{
    let status:ReminderChannelDelivery['status']='pending';const nextAt=upcoming?iso(Date.parse(upcoming.run_at)):null;
    const receipts:Row[]=recent?.receipts.filter((r:Row)=>r.channel===kind)||[];
    if(!channel(reminder)[kind])status='off';
    else if(!options.index||kind==='browser'&&!options.push||kind==='email'&&!email?.configured)status='unconfigured';
    else if(kind==='browser'?!deviceCount:!email?.enabled||!email.verified||email.suspended)status='not_ready';
    else if(receipts.some(r=>r.state==='limited'))status='limited';
    else if(receipts.some(r=>r.state==='temporary'))status='retrying';
    else if(receipts.some(r=>['unknown','sending','ready'].includes(r.state)))status='unknown';
    else if(receipts.some(r=>r.state==='failed'))status='failed';
    else if(receipts.some(r=>r.state==='accepted'))status='accepted';
    else if(kind==='email'&&recent?.state==='pending'&&recent?.outcome==='failed')status='retrying';
    else if(kind==='email'&&recent?.state==='complete'&&recent?.outcome==='failed')status='failed';
    else if(upcoming?.registered_at&&registered)status='scheduled';
    else if(upcoming&&!registered)status='registration_failed';
    else if(!upcoming&&reminder.dueAt&&reminder.days.every(n=>Date.parse(reminder.dueAt!)-n*86400000<=now()))status='finished';
    return{status,nextAt:['off','unconfigured','not_ready'].includes(status)?null:nextAt};
   }
   return{...reminder,channelDelivery:{browser:status('browser'),email:status('email')}};
  });
  let schedulerHealth:ReminderState['schedulerHealth']='unconfigured',schedulerCheckedAt:string|null=null;
  if(options.index)try{const snapshot=await options.index.read();const checked=snapshot?.value.lastTick;schedulerHealth=!registered?'failed':!checked?'waiting':now()-checked>600000?'stale':'active';schedulerCheckedAt=checked?iso(checked):null;}catch{schedulerHealth='failed';}
  return{...state,reminders,watches:[],scheduler:'aliyun-fc',schedulerHealth,schedulerCheckedAt,deliveryMode:'minute',queueConfigured:Boolean(options.index),deviceCount,email};
 }
 return{register,tick,decorate};
}
