import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {AnonymousImport,AnonymousTransfer,School} from '@campus/contracts';
import type {SqlPool,SqlClient} from './postgres-storage';
import {postgresRepository} from './postgres-repository';
import {feedSourceDefinitions} from './source-feed-preferences';
import {isPrivate,itemVisible} from './scope';
import {isRetained} from './gateway';
import {checkedLabels} from './notice-labels';
import {reject} from './errors';

export interface GuestRef {id:string;owner:string}
interface Options {now?:()=>number;dailyCreations?:number}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const id=()=>randomUUID().replace(/-/g,'');
const iso=(time:number)=>new Date(time).toISOString();
const object=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
const guest=(value:GuestRef)=>{if(!/^[a-f0-9]{32}$/.test(value.id)||value.owner!=='guest_'+value.id)reject('UNAUTHENTICATED','匿名身份已失效，请重新打开工作区。');};
const invalid=()=>reject('TRANSFER_INVALID','迁移码无效、已过期、已撤销或已被其他设备使用。');

export function anonymousWorkspaces(pool:SqlPool,options:Options={}){
 const now=options.now||Date.now;
 async function transaction<T>(run:(client:SqlClient)=>Promise<T>){
  const client=await pool.connect();
  try{await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='12000'");const result=await run(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 }
 async function limit(sql:Pick<SqlClient,'query'>,kind:string,subject:string,maximum:number,window=86400000){
  const start=Math.floor(now()/window)*window,bucket=kind+':'+start;
  const result=await sql.query(`INSERT INTO campus_guest_limits(bucket,subject,used,expires_at) VALUES($1,$2,1,$3)
   ON CONFLICT(bucket,subject) DO UPDATE SET used=campus_guest_limits.used+1 WHERE campus_guest_limits.used<$4 RETURNING used`,[bucket,hash(subject),iso(start+window*2),maximum]);
  if(!result.rows.length)reject('GUEST_RATE_LIMIT','操作过于频繁，请稍后再试。');
 }
 async function lock(sql:SqlClient,ref:GuestRef){guest(ref);if(!(await sql.query('SELECT id FROM campus_guest_workspaces WHERE id=$1 FOR UPDATE',[ref.id])).rows.length)reject('UNAUTHENTICATED','匿名身份已失效，请重新打开工作区。');}
 async function create(clientAddress:string){
  const workspace=id(),token=randomBytes(32).toString('base64url'),expiresAt=iso(now()+365*86400000);
  await transaction(async sql=>{
   await limit(sql,'new-global','all',options.dailyCreations??2000);
   await limit(sql,'new-address',clientAddress||'unknown',60,3600000);
   await sql.query('INSERT INTO campus_guest_workspaces(id,created_at,last_seen_at) VALUES($1,$2,$2)',[workspace,iso(now())]);
   await sql.query('INSERT INTO campus_guest_sessions(token_hash,workspace_id,expires_at) VALUES($1,$2,$3)',[hash(token),workspace,expiresAt]);
  });return{guest:{id:workspace,owner:'guest_'+workspace},token,expiresAt};
 }
 async function resolve(token:string|undefined):Promise<GuestRef|null>{
  if(!token||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
  const row=(await pool.query('SELECT workspace_id FROM campus_guest_sessions WHERE token_hash=$1 AND expires_at>$2',[hash(token),iso(now())])).rows[0];
  return row?{id:row.workspace_id,owner:'guest_'+row.workspace_id}:null;
 }
 async function state(ref:GuestRef){guest(ref);const row=(await pool.query('SELECT expires_at FROM campus_guest_transfers WHERE workspace_id=$1 AND consumed_at IS NULL AND expires_at>$2',[ref.id,iso(now())])).rows[0];return{id:ref.id,transferExpiresAt:row?new Date(row.expires_at).toISOString():null};}
 async function generate(ref:GuestRef):Promise<AnonymousTransfer>{
  guest(ref);await limit(pool,'transfer-minute',ref.id,1,60000);await limit(pool,'transfer-day',ref.id,20);
  const code='CR-'+randomBytes(32).toString('base64url'),expiresAt=iso(now()+1800000);
  await transaction(async sql=>{
   await lock(sql,ref);
   await sql.query('UPDATE campus_guest_transfers SET consumed_at=$2 WHERE workspace_id=$1 AND consumed_at IS NULL',[ref.id,iso(now())]);
   await sql.query('INSERT INTO campus_guest_transfers(token_hash,workspace_id,created_at,expires_at) VALUES($1,$2,$3,$4)',[hash(code),ref.id,iso(now()),expiresAt]);
  });return{code,expiresAt};
 }
 async function cancel(ref:GuestRef){guest(ref);await pool.query('UPDATE campus_guest_transfers SET consumed_at=$2 WHERE workspace_id=$1 AND consumed_at IS NULL',[ref.id,iso(now())]);}

 async function snapshot(sql:SqlClient,owner:string){
  const scoped:SqlPool={query:(text,values)=>sql.query(text,values),connect:async()=>sql};
  const repo=postgresRepository(scoped),profile=object((await sql.query("SELECT body FROM campus_documents WHERE collection='user_profiles' AND id=$1",[owner])).rows[0]?.body);
  const reminders=object((await sql.query('SELECT body FROM campus_reminder_accounts WHERE owner_id=$1',[owner])).rows[0]?.body);
  const labels=(await sql.query('SELECT item_id,categories FROM campus_notice_labels WHERE owner_id=$1 ORDER BY item_id LIMIT 1001',[owner])).rows;
  const bookmarks=Array.isArray(profile.webBookmarks)?profile.webBookmarks:[],sourceReminders=Array.isArray(reminders.reminders)?reminders.reminders:[];
  if(bookmarks.length>500||sourceReminders.length>100||labels.length>1000)reject('TRANSFER_LIMIT','迁移数据超过单次上限，请先整理收藏、标签或提醒。');
  let skipped=0;
  const schools=new Map<string,School|null>(),scopes=new Map<string,Awaited<ReturnType<typeof repo.scope>>>();
  // Bounded bulk metadata reads avoid a network round trip for every saved
  // notice when importing a full bookmark or label collection.
  const wanted=[...new Set([...bookmarks.map(row=>row?.itemId),...sourceReminders.map(row=>row?.itemId),...labels.map(row=>row.item_id)].filter(identifier))];
  const items=new Map<string,Awaited<ReturnType<typeof repo.item>>>(wanted.map(key=>[key,null]));
  for(const row of (await sql.query("SELECT id,body FROM campus_documents WHERE collection='items' AND id=ANY($1::text[])",[wanted])).rows)items.set(row.id,{...row.body,_id:row.id});
  async function school(schoolId:string){if(!schools.has(schoolId))schools.set(schoolId,await repo.school(schoolId));return schools.get(schoolId);}
  async function item(itemId:string){if(!items.has(itemId))items.set(itemId,await repo.item(itemId));return items.get(itemId);}
  async function readable(schoolId:unknown,itemId:unknown){
   if(!identifier(schoolId)||!identifier(itemId)||!await school(schoolId))return false;
   const row=await item(itemId);if(!row||isPrivate(row)||row.status!=='published'||!isRetained(row,iso(now()-365*86400000)))return false;
   if(!scopes.has(schoolId))scopes.set(schoolId,await repo.scope(schoolId,owner));
   return itemVisible(row,scopes.get(schoolId)!);
  }
  const selected=identifier(profile.selectedSchoolId)&&await school(profile.selectedSchoolId)?profile.selectedSchoolId:null;
  const saved:Array<{schoolId:string;itemId:string;savedAt:string}>=[];
  for(const row of bookmarks){if(!await readable(row?.schoolId,row?.itemId)){skipped++;continue;}if(!saved.some(entry=>entry.schoolId===row.schoolId&&entry.itemId===row.itemId))saved.push({schoolId:row.schoolId,itemId:row.itemId,savedAt:Number.isFinite(Date.parse(row.savedAt))?new Date(row.savedAt).toISOString():iso(now())});}
  const notices:Array<Record<string,any>>=[];
  for(const row of sourceReminders){
   if(!await readable(row?.schoolId,row?.itemId)){skipped++;continue;}
   const article=(await item(row.itemId))!,schoolName=(await school(row.schoolId))!.name;
   const future=typeof row.dueAt==='string'&&Date.parse(row.dueAt)>now()&&Date.parse(row.dueAt)<=now()+2*366*86400000;
   const days=future&&Array.isArray(row.days)?[...new Set(row.days)].filter((value):value is number=>[0,1,3,7].includes(value as number)&&Date.parse(row.dueAt)-Number(value)*86400000>now()):[];
   notices.push({id:id(),schoolId:row.schoolId,itemId:row.itemId,title:String(article.title||'未命名公告').slice(0,300),schoolName,label:typeof row.label==='string'?row.label.slice(0,80):'事项截止',dueAt:future&&days.length?new Date(row.dueAt).toISOString():null,days,channels:{browser:false,email:false},generation:id(),fired:[],createdAt:iso(now())});
  }
  const tags:Array<{itemId:string;categories:string[]}>=[];
  for(const row of labels){
   const article=await item(row.item_id),candidates=[...new Set([...(article?.schoolIds||[]),...saved.filter(entry=>entry.itemId===row.item_id).map(entry=>entry.schoolId),...notices.filter(entry=>entry.itemId===row.item_id).map(entry=>entry.schoolId),...(selected?[selected]:[])])];
   let visible=false;for(const schoolId of candidates)if(await readable(schoolId,row.item_id)){visible=true;break;}
   if(!visible){skipped++;continue;}try{const categories=checkedLabels(row.categories);if(categories)tags.push({itemId:row.item_id,categories});}catch{skipped++;}
  }
  const choices:Record<string,Record<string,boolean>>={};
  const choiceSchools=[...new Set([...Object.keys(object(profile.sourceFeedVisibility)),...Object.keys(object(profile.hiddenFeedSources))])];
  if(choiceSchools.length>200)reject('TRANSFER_LIMIT','来源设置超过单次迁移上限。');
  for(const schoolId of choiceSchools){
   if(!identifier(schoolId))continue;const current=await school(schoolId);if(!current)continue;
   const allowed=new Set((await feedSourceDefinitions(scoped,current,owner)).filter(entry=>entry.kind!=='personal'&&!entry.categories.includes('mail')).map(entry=>entry.id));
   const entries:Record<string,boolean>={};
   for(const hidden of Array.isArray(profile.hiddenFeedSources?.[schoolId])?profile.hiddenFeedSources[schoolId]:[])if(allowed.has(hidden))entries[hidden]=false;
   for(const [sourceId,value] of Object.entries(object(profile.sourceFeedVisibility?.[schoolId])))if(allowed.has(sourceId)&&typeof value==='boolean')entries[sourceId]=value;
   if(Object.keys(entries).length)choices[schoolId]=entries;
  }
  return{selected,saved,notices,tags,choices,skipped};
 }

 async function importCode(target:GuestRef,value:string):Promise<AnonymousImport>{
  guest(target);const code=typeof value==='string'?value.trim():'';if(!/^CR-[A-Za-z0-9_-]{43}$/.test(code))invalid();
  await limit(pool,'import-attempts',target.id,30,900000);
  return transaction(async sql=>{
   await lock(sql,target);
   const transfer=(await sql.query('SELECT * FROM campus_guest_transfers WHERE token_hash=$1 FOR UPDATE',[hash(code)])).rows[0];
   if(!transfer)invalid();
   if(transfer.consumed_at){if(transfer.consumed_by===target.id&&transfer.result)return transfer.result as AnonymousImport;invalid();}
   if(Date.parse(transfer.expires_at)<=now())invalid();
   if(transfer.workspace_id===target.id)reject('TRANSFER_SAME_DEVICE','请在另一台设备或另一个浏览器中导入此迁移码。');
   const source=await snapshot(sql,'guest_'+transfer.workspace_id);
   await sql.query("INSERT INTO campus_documents(collection,id,body) VALUES('user_profiles',$1,'{}'::jsonb) ON CONFLICT DO NOTHING",[target.owner]);
   const original=object((await sql.query("SELECT body FROM campus_documents WHERE collection='user_profiles' AND id=$1 FOR UPDATE",[target.owner])).rows[0]?.body);
   const saved=Array.isArray(original.webBookmarks)?[...original.webBookmarks]:[];let bookmarks=0;
   for(const row of source.saved)if(!saved.some(entry=>entry.schoolId===row.schoolId&&entry.itemId===row.itemId)){saved.push(row);bookmarks++;}
   if(saved.length>500)reject('TRANSFER_LIMIT','导入后收藏超过500条，请先整理当前设备收藏。');
   const choices={...object(original.sourceFeedVisibility)},hidden={...object(original.hiddenFeedSources)};let sources=0;
   for(const [schoolId,values] of Object.entries(source.choices)){
    const prior={...object(choices[schoolId])};for(const key of Array.isArray(hidden[schoolId])?hidden[schoolId]:[])if(!(key in prior))prior[key]=false;
    sources+=Object.keys(values).filter(key=>!(key in prior)).length;choices[schoolId]={...values,...prior};hidden[schoolId]=Object.entries(choices[schoolId]).filter(([,visible])=>visible===false).map(([key])=>key);
   }
   const schoolId=source.selected||(identifier(original.selectedSchoolId)?original.selectedSchoolId:null);
   await sql.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='user_profiles' AND id=$1",[target.owner,JSON.stringify({...(schoolId?{selectedSchoolId:schoolId}:{}),webBookmarks:saved,sourceFeedVisibility:choices,hiddenFeedSources:hidden})]);
   const tags=(await sql.query('INSERT INTO campus_notice_labels(owner_id,item_id,categories) SELECT $1,x."itemId",x.categories FROM jsonb_to_recordset($2::jsonb) AS x("itemId" text,categories jsonb) ON CONFLICT DO NOTHING RETURNING item_id',[target.owner,JSON.stringify(source.tags)])).rows.length;
   const count=Number((await sql.query('SELECT count(*) AS count FROM campus_notice_labels WHERE owner_id=$1',[target.owner])).rows[0].count);if(count>2000)reject('TRANSFER_LIMIT','导入后标签数量超过上限，请先整理当前设备标签。');
   await sql.query('INSERT INTO campus_reminder_accounts(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[target.owner]);
   const reminderBody=object((await sql.query('SELECT body FROM campus_reminder_accounts WHERE owner_id=$1 FOR UPDATE',[target.owner])).rows[0].body),reminders=Array.isArray(reminderBody.reminders)?[...reminderBody.reminders]:[];let added=0;
   for(const row of source.notices)if(!reminders.some(entry=>entry.schoolId===row.schoolId&&entry.itemId===row.itemId)){reminders.push(row);added++;}
   if(reminders.length>100)reject('TRANSFER_LIMIT','导入后提醒超过100条，请先整理当前设备提醒。');
   await sql.query('UPDATE campus_reminder_accounts SET body=$2::jsonb WHERE owner_id=$1',[target.owner,JSON.stringify({...reminderBody,reminders,watches:reminderBody.watches||[],notifications:reminderBody.notifications||[]})]);
   await sql.query('UPDATE campus_reminder_email SET verified_at=NULL,enabled=false,token_hash=NULL,token_expires=NULL,unsubscribe_hash=NULL,binding_id=$2,updated_at=$3 WHERE owner_id=$1',[target.owner,id(),iso(now())]);
   const result:AnonymousImport={schoolId,bookmarks,tags,sources,reminders:added,skipped:source.skipped,emailReverificationRequired:true,pushReauthorizationRequired:true};
   await sql.query('UPDATE campus_guest_transfers SET consumed_at=$2,consumed_by=$3,result=$4::jsonb WHERE token_hash=$1',[hash(code),iso(now()),target.id,JSON.stringify(result)]);
   return result;
  });
 }
 return{create,resolve,state,generate,cancel,importCode};
}

export async function cleanupAnonymous(pool:SqlPool,now=Date.now()){
 await pool.query('DELETE FROM campus_guest_transfers WHERE token_hash IN (SELECT token_hash FROM campus_guest_transfers WHERE expires_at<$1 ORDER BY expires_at LIMIT 1000)',[iso(now-86400000)]);
 await pool.query('DELETE FROM campus_guest_sessions WHERE token_hash IN (SELECT token_hash FROM campus_guest_sessions WHERE expires_at<$1 ORDER BY expires_at LIMIT 1000)',[iso(now)]);
 await pool.query('DELETE FROM campus_guest_limits WHERE (bucket,subject) IN (SELECT bucket,subject FROM campus_guest_limits WHERE expires_at<$1 ORDER BY expires_at LIMIT 1000)',[iso(now)]);
}
