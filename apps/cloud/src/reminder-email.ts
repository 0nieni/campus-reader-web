import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {ReminderEmailState} from '@campus/contracts';
import type {SqlClient,SqlPool,Row} from './postgres-storage';
import type {MailSender} from './directmail';
import {normalizedEmail} from './site-access';
import {reject} from './errors';
export const reminderOrigin='https://campus-reader-ninie6159.netlify.app';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const iso=(time:number)=>new Date(time).toISOString();
const uuid=()=>randomUUID().replace(/-/g,'');
export type EmailIdentityResolver=(id:string)=>Promise<{email?:string}|null>;
export interface EmailOptions {sender?:MailSender;dailyLimit?:number;now?:()=>number;resolveIdentity?:EmailIdentityResolver}
export async function reserveEmail(sql:SqlClient,owner:string,kind:string,time:number,globalLimit=150){
 // Beijing calendar day. All attempts, including verification, tests and
 // retries, reserve atomically; uncertain/failed requests are never refunded.
 const date=new Date(time+8*3600000).toISOString().slice(0,10);
 for(const [key,type,limit] of [['*','all',globalLimit],[owner,'all',20],[owner,kind,kind==='verify'?3:20]] as const){
  const result=await sql.query(`INSERT INTO campus_reminder_email_budget(day,owner_id,kind,used) VALUES($1,$2,$3,1)
   ON CONFLICT(day,owner_id,kind) DO UPDATE SET used=campus_reminder_email_budget.used+1 WHERE campus_reminder_email_budget.used<$4 RETURNING used`,[date,key,type,limit]);
  if(!result.rows.length)reject('EMAIL_LIMIT','邮件发送量已达今日上限，请明天再试。站内提醒和浏览器通知仍可使用。');
 }
}
export function reminderEmail(pool:SqlPool,options:EmailOptions={}){
 const now=options.now||Date.now;
 async function transaction<T>(owner:string,run:(client:SqlClient,row:Row|undefined)=>Promise<T>){
  const client=await pool.connect();try{
   await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='6000'");
   await client.query('INSERT INTO campus_reminder_accounts(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
   await client.query('SELECT owner_id FROM campus_reminder_accounts WHERE owner_id=$1 FOR UPDATE',[owner]);
   const {rows}=await client.query('SELECT * FROM campus_reminder_email WHERE owner_id=$1 FOR UPDATE',[owner]);
   const result=await run(client,rows[0]);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 }
 async function bind(owner:string,identityId:string,email:string){
  const address=normalizedEmail(email);if(!address)reject('EMAIL_NOT_READY','账号没有有效邮箱。');
  await transaction(owner,async(client,row)=>{
   if(!row)await client.query('INSERT INTO campus_reminder_email(owner_id,identity_id,email,binding_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',[owner,identityId,address,uuid(),iso(now())]);
   else if(row.email!==address||row.identity_id!==identityId)await client.query(`UPDATE campus_reminder_email SET identity_id=$2,email=$3,binding_id=$4,verified_at=NULL,enabled=false,suspended=false,token_hash=NULL,token_expires=NULL,unsubscribe_hash=NULL,feedback_due_at=NULL,feedback_until=NULL,updated_at=$5 WHERE owner_id=$1`,[owner,identityId,address,uuid(),iso(now())]);
  });
 }
 async function state(owner:string):Promise<ReminderEmailState>{
  const {rows}=await pool.query('SELECT email,verified_at,enabled,suspended,last_verify_at FROM campus_reminder_email WHERE owner_id=$1',[owner]);const row=rows[0];
  const used=await pool.query("SELECT used FROM campus_reminder_email_budget WHERE day=$1 AND owner_id=$2 AND kind='all'",[new Date(now()+8*3600000).toISOString().slice(0,10),owner]);
  const address=String(row?.email||''),at=address.indexOf('@');
  return{configured:Boolean(options.sender),address:at>0?address.slice(0,Math.min(at,2))+'***'+address.slice(at):null,verified:Boolean(row?.verified_at),enabled:Boolean(row?.enabled),suspended:Boolean(row?.suspended),usedToday:Number(used.rows[0]?.used||0),dailyLimit:20,...(owner.startsWith('guest_')?{identityKind:'guest' as const}:{})};
 }
 async function bindGuest(owner:string,email:unknown){
  if(!/^guest_[a-f0-9]{32}$/.test(owner))reject('FORBIDDEN','只能为当前匿名工作区设置提醒邮箱。');
  const address=normalizedEmail(email);if(!address)reject('VALIDATION_FAILED','请输入有效的提醒邮箱。');
  const identityId=owner.slice(6);
  if(!(await pool.query('SELECT id FROM campus_guest_workspaces WHERE id=$1',[identityId])).rows.length)reject('UNAUTHENTICATED','匿名身份已失效。');
  await transaction(owner,async(client,row)=>{
   if(row?.email===address&&row.identity_kind==='guest')return;
   if(row?.last_verify_at&&now()-Date.parse(row.last_verify_at)<60000)reject('EMAIL_RATE_LIMIT','请间隔至少60秒再更换或验证邮箱。');
   if(!row)await client.query("INSERT INTO campus_reminder_email(owner_id,identity_id,email,binding_id,created_at,updated_at,identity_kind) VALUES($1,$2,$3,$4,$5,$5,'guest')",[owner,identityId,address,uuid(),iso(now())]);
   else await client.query("UPDATE campus_reminder_email SET identity_id=$2,email=$3,binding_id=$4,identity_kind='guest',verified_at=NULL,enabled=false,suspended=false,token_hash=NULL,token_expires=NULL,unsubscribe_hash=NULL,feedback_due_at=NULL,feedback_until=NULL,updated_at=$5 WHERE owner_id=$1",[owner,identityId,address,uuid(),iso(now())]);
  });return state(owner);
 }
 async function current(owner:string,binding?:string){
  const {rows}=await pool.query('SELECT * FROM campus_reminder_email WHERE owner_id=$1',[owner]);const row=rows[0];if(!row||binding&&row.binding_id!==binding)return;
  if(row.identity_kind==='guest'){
   if(owner!=='guest_'+row.identity_id||!(await pool.query('SELECT id FROM campus_guest_workspaces WHERE id=$1',[row.identity_id])).rows.length)return;
   return row;
  }
  // Never trust an old copied login address. Background sends re-read the
  // authoritative Identity user; failures postpone sending instead of using it.
  if(!options.resolveIdentity)throw Error('Identity resolver unavailable');
  const identity=await options.resolveIdentity(row.identity_id);
  if(normalizedEmail(identity?.email)!==row.email){
   await transaction(owner,async(client,latest)=>{if(latest?.binding_id===row.binding_id)await client.query('UPDATE campus_reminder_email SET enabled=false,verified_at=NULL,token_hash=NULL,token_expires=NULL,unsubscribe_hash=NULL,binding_id=$2,updated_at=$3 WHERE owner_id=$1',[owner,uuid(),iso(now())]);});return;
  }return row;
 }
 async function handle(action:string,input:Record<string,unknown>,owner:string){
  if(action==='reminders.email.enable'){
   if(typeof input.enabled!=='boolean')reject('VALIDATION_FAILED','请选择邮件开关。');
   if(input.enabled){if(!options.sender)reject('EMAIL_UNAVAILABLE','邮件服务待配置，暂不能开启。');await current(owner);}
   await transaction(owner,async(client,row)=>{
    if(!row||input.enabled&&(!row.verified_at||row.suspended))reject('EMAIL_NOT_READY','请先验证当前邮箱；退信或投诉暂停的地址需处理后重新验证。');
    await client.query('UPDATE campus_reminder_email SET enabled=$2,enabled_at=CASE WHEN $2 AND NOT enabled THEN $3 ELSE enabled_at END,updated_at=$3 WHERE owner_id=$1',[owner,input.enabled,iso(now())]);
   });return state(owner);
  }
  if(!['reminders.email.verify','reminders.email.test'].includes(action))reject('ACTION_NOT_ALLOWED','邮件操作不存在。');
  const sender=options.sender;if(!sender)reject('EMAIL_UNAVAILABLE','邮件服务待配置。预览环境不发送真实邮件。');
  const currentRow=await current(owner);if(!currentRow)reject('EMAIL_NOT_READY','账号邮箱已变化，请刷新后重新验证。');
  const verification=action==='reminders.email.verify',token=randomBytes(32).toString('hex'),unsubscribe=hash(currentRow.binding_id+'/unsubscribe/'+owner);
  const row=await transaction(owner,async(client,row)=>{
   if(!row||row.binding_id!==currentRow.binding_id)reject('EMAIL_NOT_READY','邮箱已变化，请刷新后重试。');
   if(!verification&&(!row.enabled||!row.verified_at||row.suspended))reject('EMAIL_NOT_READY','请先验证并主动开启邮件提醒，再发送测试邮件。');
   const field=verification?'last_verify_at':'last_test_at';if(row[field]&&now()-Date.parse(row[field])<60000)reject('EMAIL_RATE_LIMIT','请间隔至少60秒再发送。');
   await reserveEmail(client,owner,verification?'verify':'test',now(),options.dailyLimit);
   if(verification&&row.identity_kind==='guest'){
    const recipient=await client.query("INSERT INTO campus_reminder_email_budget(day,owner_id,kind,used) VALUES($1,$2,'verify',1) ON CONFLICT(day,owner_id,kind) DO UPDATE SET used=campus_reminder_email_budget.used+1 WHERE campus_reminder_email_budget.used<3 RETURNING used",[new Date(now()+8*3600000).toISOString().slice(0,10),'recipient:'+hash(row.email)]);
    if(!recipient.rows.length)reject('EMAIL_LIMIT','该邮箱今日验证邮件已达上限，请明天再试。');
   }
   if(verification)await client.query('UPDATE campus_reminder_email SET token_hash=$2,token_expires=$3,last_verify_at=$4,updated_at=$4 WHERE owner_id=$1',[owner,hash(token),iso(now()+1800000),iso(now())]);
   else await client.query('UPDATE campus_reminder_email SET last_test_at=$2,unsubscribe_hash=$3,updated_at=$2 WHERE owner_id=$1',[owner,iso(now()),hash(unsubscribe)]);
   return row;
  });
  const latest=await current(owner,row.binding_id);if(!latest||!verification&&(!latest.enabled||latest.suspended))reject('EMAIL_NOT_READY','邮箱设置已变化，已停止发送。');
  const body=verification?`请点击下面的链接并确认验证当前账号邮箱。链接30分钟有效，仅能使用一次。验证不会自动开启邮件提醒。\n${reminderOrigin}/.netlify/functions/reminder-email#verify=${token}\n若不是本人操作，请忽略此邮件。`:`这是一封校园阅览室测试邮件。邮件服务接收请求不代表已进入收件箱，请核对垃圾箱。\n查看提醒：${reminderOrigin}/?view=reminders\n关闭邮件：${reminderOrigin}/.netlify/functions/reminder-email#unsubscribe=${unsubscribe}`;
  const result=await sender.send(row.email,verification?'校园阅览室｜验证提醒邮箱':'校园阅览室｜邮件提醒测试',body);
  if(result.invalid)await suspend(owner,row.binding_id);
  if(result.state!=='accepted')reject(result.state==='unknown'?'EMAIL_UNKNOWN':'EMAIL_FAILED',result.state==='unknown'?'邮件发送结果未知，请先查看邮箱；系统未自动重发。':'邮件服务未接收，请检查配置或稍后再试。');
  if(!verification)await noteAccepted(owner,row.binding_id);
  return state(owner);
 }
 async function consume(kind:string,token:string){
  if(!['verify','unsubscribe'].includes(kind)||! /^[a-f0-9]{64}$/.test(token))reject('VALIDATION_FAILED','链接无效或已过期。');
  const column=kind==='verify'?'token_hash':'unsubscribe_hash',found=await pool.query(`SELECT owner_id,binding_id FROM campus_reminder_email WHERE ${column}=$1`,[hash(token)]),row=found.rows[0];
  if(!row)reject('EMAIL_LINK_EXPIRED','链接无效、已使用或已过期。');
  if(kind==='verify'&&!await current(row.owner_id,row.binding_id))reject('EMAIL_LINK_EXPIRED','账号邮箱已变化，请重新发送验证邮件。');
  await transaction(row.owner_id,async(client,latest)=>{
   if(!latest||latest.binding_id!==row.binding_id||latest[column]!==hash(token)||kind==='verify'&&Date.parse(latest.token_expires)<now())reject('EMAIL_LINK_EXPIRED','链接无效、已使用或已过期。');
   if(kind==='verify')await client.query('UPDATE campus_reminder_email SET verified_at=$2,suspended=false,token_hash=NULL,token_expires=NULL,updated_at=$2 WHERE owner_id=$1',[row.owner_id,iso(now())]);
   else await client.query('UPDATE campus_reminder_email SET enabled=false,unsubscribe_hash=NULL,updated_at=$2 WHERE owner_id=$1',[row.owner_id,iso(now())]);
  });return{verified:kind==='verify'};
 }
 async function suspend(owner:string,binding:string){await pool.query('UPDATE campus_reminder_email SET enabled=false,suspended=true,feedback_due_at=NULL,feedback_until=NULL,updated_at=$3 WHERE owner_id=$1 AND binding_id=$2',[owner,binding,iso(now())]);}
 async function noteAccepted(owner:string,binding:string){
  await pool.query(`UPDATE campus_reminder_email SET feedback_due_at=least(coalesce(feedback_due_at,$3),$3),feedback_until=greatest(coalesce(feedback_until,$4),$4),feedback_failures=0
   WHERE owner_id=$1 AND binding_id=$2 AND enabled=true AND suspended=false AND verified_at IS NOT NULL`,[owner,binding,iso(now()+1800000),iso(now()+86400000)]);
 }
 async function unsubscribeLink(owner:string,binding:string){
  const token=hash(binding+'/unsubscribe/'+owner);const result=await pool.query('UPDATE campus_reminder_email SET unsubscribe_hash=$3 WHERE owner_id=$1 AND binding_id=$2 RETURNING owner_id',[owner,binding,hash(token)]);
  return result.rows.length?`${reminderOrigin}/.netlify/functions/reminder-email#unsubscribe=${token}`:null;
 }
 async function feedback(limit=20,dueOnly=false){
  if(!options.sender?.suppressed)return{checked:0,suspended:0};
  const {rows}=await pool.query("SELECT owner_id,email,binding_id,verified_at,feedback_due_at,feedback_until,feedback_failures FROM campus_reminder_email WHERE enabled=true AND verified_at IS NOT NULL AND ($2::boolean=false OR feedback_due_at<=$3) ORDER BY feedback_due_at,owner_id LIMIT $1",[limit,dueOnly,iso(now())]);let checked=0,suspended=0,failed=0;
  await Promise.all(rows.map(async row=>{
   let next:string|null=null,failures=0;
   try{
    if(await options.sender!.suppressed!(row.email,Date.parse(row.verified_at))){await suspend(row.owner_id,row.binding_id);suspended++;}
    else if(row.feedback_until&&Date.parse(row.feedback_until)>now())next=iso(Date.parse(row.feedback_until));
    checked++;
   }catch{failures=Number(row.feedback_failures)+1;failed++;if(failures<3)next=iso(now()+3600000);}
   // A new accepted message can schedule an earlier check while a provider
   // query is in flight. Preserve that new schedule with a SQL CAS.
   await pool.query(`UPDATE campus_reminder_email SET feedback_checked_at=$3,feedback_due_at=$4,feedback_failures=$5
    WHERE owner_id=$1 AND binding_id=$2 AND feedback_due_at IS NOT DISTINCT FROM $6::timestamptz AND feedback_until IS NOT DISTINCT FROM $7::timestamptz`,[row.owner_id,row.binding_id,iso(now()),next,failures,row.feedback_due_at,row.feedback_until]);
  }));if(rows.length)console.info(JSON.stringify({event:'reminder-mail-feedback',checked,suspended,failed}));return{checked,suspended,failed};
 }
 async function verifiedAddress(owner:string){const row=await current(owner);return row?.verified_at&&!row.suspended?row.email as string:null;}
 return{bind,bindGuest,state,current,verifiedAddress,handle,consume,suspend,unsubscribeLink,feedback,noteAccepted,sender:options.sender,dailyLimit:options.dailyLimit??150};
}
