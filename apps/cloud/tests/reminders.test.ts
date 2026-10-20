import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createECDH,randomBytes} from 'node:crypto';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import {postgresStorage,type SqlPool} from '../src/postgres-storage';
import {postgresRepository} from '../src/postgres-repository';
import {createGateway} from '../src/gateway';
import {reminderService,runReminderTick} from '../src/reminders';
import {checkedSubscription,createPushRequest,type PushConfig} from '../src/browser-push';
import webpush from 'web-push';
import {foldCalendarLine} from '../src/reminder-calendar';
import {cleanupReminderData} from '../src/reminder-cleanup';

const device=(token:string)=>{const key=createECDH('prime256v1');key.generateKeys();return{endpoint:`https://fcm.googleapis.com/fcm/send/${token}`,keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};};
const push:PushConfig={publicKey:'synthetic-public',privateKey:'synthetic-private',subject:'https://example.test'};
test('push subscriptions validate vendor URLs and EC keys without allowing arbitrary requests',()=>{
 const valid=device('fake-device');assert.deepEqual(checkedSubscription(valid),valid);
 for(const endpoint of ['https://127.0.0.1/x','https://fcm.googleapis.com.evil.example/x','http://fcm.googleapis.com/x','https://user:pass@fcm.googleapis.com/x','https://fcm.googleapis.com:8443/x','https://evil.example/x','file:///C:/secret'])assert.throws(()=>checkedSubscription({...valid,endpoint}));
 assert.throws(()=>checkedSubscription({...valid,keys:{p256dh:'a'.repeat(87),auth:'a'.repeat(22)}}));
 const long='SUMMARY:'+('比赛报名；认真核对时间🚩'.repeat(30));const folded=foldCalendarLine(long);assert.ok(folded.split('\r\n').every(line=>Buffer.byteLength(line)<=75));assert.equal(folded.replace(/\r\n /g,''),long);
});
test('real Web Push encryption and VAPID signatures are generated without a network call',()=>{
 const keys=webpush.generateVAPIDKeys(),subscription=device('encrypted-fixture');
 const details=createPushRequest(subscription,{...keys,subject:'https://example.test'},'synthetic-digest');
 assert.equal(details.method,'POST');assert.equal(details.headers['Content-Encoding'],'aes128gcm');
 assert.ok(String(details.headers.Authorization).startsWith('vapid '));assert.ok(details.body&&details.body.length>100);
 assert.ok(!details.body!.toString().includes('你有新的提醒'));assert.equal(details.headers.TTL,86400);
});

test('reminders and watches use real local SQL, isolated owners and a durable deduplicated inbox',async t=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),database=getDatabase({connectionString}),nativePool=database.pool;
 (nativePool as unknown as {options:{max:number}}).options.max=1;
 const pool=nativePool as unknown as SqlPool,repo=postgresRepository(pool),db=postgresStorage(pool);
 let clock=Date.now(),sent=0,mode:'ok'|'gone'|'unknown'='ok';
 const options={now:()=>clock,push,send:async()=>{sent++;if(mode!=='ok')throw Object.assign(new Error('synthetic failure'),{statusCode:mode==='gone'?410:undefined});}};
 const service=reminderService(pool,options);
 const gateway=(owner:string)=>createGateway(repo,{ownerUid:owner,dataOwnerId:owner},()=>clock,{reminders:service});
 const call=(owner:string,action:string,input:Record<string,unknown>={})=>gateway(owner)({action,input},{uid:owner,isAnonymous:false});
 const data=async(owner:string,action:string,input:Record<string,unknown>={})=>{const result=await call(owner,action,input);assert.ok(result.ok,JSON.stringify(result));return result.data as any;};
 const put=async(itemId:string,title:string,extra={})=>{
  await db.collection('items').doc(itemId).set({title,scope:'school',schoolIds:['bjtu'],status:'published',publishedAt:new Date(clock).toISOString(),createdAt:new Date(clock).toISOString(),sourceId:'synthetic_source',categories:['school'],...extra});
  await pool.query('UPDATE campus_notice_arrivals SET arrived_at=$2 WHERE item_id=$1',[itemId,new Date(clock).toISOString()]);
 };
 const advance=(ms:number)=>{clock+=ms;};
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
  await repo.selectSchool('reminder_a','bjtu');await repo.selectSchool('reminder_b','bjtu');
  await put('reminder_public','公开报名公告');await put('reminder_private','私人报名公告',{ownerOpenid:'reminder_a',scope:'private',categories:['mail']});
  await t.test('requires login and rejects forged ownership, unknown fields and inaccessible items',async()=>{
   assert.equal((await gateway('reminder_a')({action:'reminders.state',input:{}},{uid:'',isAnonymous:true})).ok,false);
   assert.equal((await call('reminder_a','reminders.state',{owner:'reminder_b'})).ok,false);
   assert.equal((await call('reminder_b','reminders.save',{schoolId:'bjtu',itemId:'reminder_private',label:'截止',dueAt:new Date(clock+86400000).toISOString(),days:[0]})).ok,false);
   assert.equal((await data('reminder_a','session.get')).capabilities.reminders,true);
  });
  let reminderId='';
  await t.test('manual reminders need no favorite or AI; dates and offsets are validated',async()=>{
   const base={schoolId:'bjtu',itemId:'reminder_public',label:'报名截止',days:[7,3,1,0]};
   for(const dueAt of ['2027-02-30T09:00:00.000Z','2027-01-01T09:00:00',new Date(clock-60000).toISOString(),new Date(clock+3*366*86400000).toISOString()])assert.equal((await call('reminder_a','reminders.save',{...base,dueAt})).ok,false);
   assert.equal((await call('reminder_a','reminders.save',{...base,dueAt:new Date(Math.floor((clock+2*86400000)/60000)*60000).toISOString(),days:[7]})).ok,false);
   const result=await data('reminder_a','reminders.save',{...base,dueAt:new Date(Math.floor((clock+2*86400000)/60000)*60000).toISOString()});
   reminderId=result.reminders[0].id;assert.deepEqual(result.reminders[0].days,[1,0]);assert.equal(result.notifications.length,0);
   assert.deepEqual((await data('reminder_b','reminders.state')).reminders,[]);
   assert.equal((await call('reminder_b','reminders.save',{...base,id:reminderId,dueAt:new Date(Math.floor((clock+86400000)/60000)*60000).toISOString()})).ok,false);
  });
  await t.test('crossed offsets combine into one notification; repeated checks and concurrency do not duplicate it',async()=>{
   advance(3*86400000);const a=await data('reminder_a','reminders.state');assert.equal(a.notifications.length,1);assert.equal(a.unread,1);
   assert.match(a.notifications[0].message,/已到时间/);
   const results=await Promise.all([data('reminder_a','reminders.state'),data('reminder_a','reminders.state')]);
   assert.ok(results.every(result=>result.notifications.length===1));
   assert.equal((await data('reminder_a','reminders.read',{id:a.notifications[0].id})).unread,0);
  });
  await t.test('editing works after switching schools; cancelling prevents later dispatch',async()=>{
   await repo.selectSchool('reminder_a','school_001');
   const result=await data('reminder_a','reminders.save',{id:reminderId,schoolId:'bjtu',itemId:'reminder_public',label:'改期报名',dueAt:new Date(Math.floor((clock+86400000)/60000)*60000).toISOString(),days:[0]});
   assert.equal(result.reminders[0].label,'改期报名');
   await data('reminder_a','reminders.remove',{id:reminderId});advance(2*86400000);
   assert.equal((await data('reminder_a','reminders.state')).reminders.length,0);await repo.selectSchool('reminder_a','bjtu');
  });
  let watchId='';
  await t.test('watches start now, match literal title keywords and never reveal another account or school',async()=>{
   await put('watch_old','比赛旧公告');advance(1000);
   const state=await data('reminder_a','reminders.watch.save',{schoolId:'bjtu',keyword:'比赛'});watchId=state.watches[0].id;
   assert.equal(state.notifications.filter((n:any)=>n.kind==='new_notice').length,0);
   advance(1000);await put('watch_new','比赛新公告');await put('watch_other','比赛其他学校',{schoolIds:['school_001']});await put('watch_secret','比赛其他人私人资料',{ownerOpenid:'reminder_b',scope:'private'});await put('watch_irrelevant','无关标题');
   advance(61000);const result=await data('reminder_a','reminders.state');
   assert.deepEqual(result.notifications.filter((n:any)=>n.kind==='new_notice').map((n:any)=>n.itemId),['watch_new']);
   assert.equal((await data('reminder_b','reminders.state')).watches.length,0);
   await put('watch_new','比赛新公告更新');advance(61000);
   assert.equal((await data('reminder_a','reminders.state')).notifications.filter((n:any)=>n.kind==='new_notice').length,1);
   assert.equal((await call('reminder_a','reminders.watch.save',{schoolId:'bjtu',keyword:'比赛'})).ok,false);
  });
  await t.test('new-announcement batches can continue beyond 50 and are deduplicated independently of the inbox',async()=>{
   advance(1000);for(let index=0;index<54;index++)await put(`watch_batch_${index}`,'比赛新入库'+index);
   advance(61000);const first=await data('reminder_a','reminders.state');assert.equal(first.more,true);
   const second=await data('reminder_a','reminders.state');assert.equal(second.notifications.filter((n:any)=>n.kind==='new_notice').length,55);assert.equal(second.more,false);
   // Trimmed notifications must not resurrect on a later check.
   await pool.query("UPDATE campus_reminder_accounts SET body=jsonb_set(body,'{notifications}','[]'::jsonb) WHERE owner_id=$1",['reminder_a']);
   advance(61000);assert.equal((await data('reminder_a','reminders.state')).notifications.length,0);
  });
  const dev=device('shared-fixture'),dev2=device('second-fixture');
  await t.test('subscriptions are bound to the authenticated owner and adding a device does not push old messages',async()=>{
   await data('reminder_a','reminders.push.subscribe',{subscription:dev});
   assert.equal((await call('reminder_b','reminders.push.test',{endpoint:dev.endpoint})).ok,false);
   await service.dispatch('reminder_a');assert.equal(sent,0);
   assert.equal((await data('reminder_a','reminders.push.test',{endpoint:dev.endpoint})).accepted,true);
   assert.equal((await call('reminder_a','reminders.push.test',{endpoint:dev.endpoint})).ok,false);assert.equal(sent,1);
  });
  await t.test('dispatch persists the inbox first, sends one generic digest and does not repeat attempts',async()=>{
   advance(61000);await put('push_new','比赛隐私标题不得出现在推送内容中');advance(61000);
   const result=await runReminderTick(pool,options);assert.equal(result.accepted,1);assert.equal(sent,2);
   await service.dispatch('reminder_a');assert.equal(sent,2);
   assert.ok((await data('reminder_a','reminders.state')).notifications.some((n:any)=>n.itemId==='push_new'));
  });
  await t.test('unknown delivery is not blindly retried; an expired endpoint is removed and inbox remains readable',async()=>{
   mode='unknown';advance(61000);await put('push_unknown','比赛未知结果');advance(61000);await service.dispatch('reminder_a');const attempts=sent;await service.dispatch('reminder_a');assert.equal(sent,attempts);
   assert.ok((await data('reminder_a','reminders.state')).notifications.some((n:any)=>n.itemId==='push_unknown'));
   await data('reminder_a','reminders.push.subscribe',{subscription:dev2});mode='gone';advance(61000);await put('push_expired','比赛端点失效');advance(61000);await service.dispatch('reminder_a');
   const remaining=await pool.query('SELECT endpoint_hash FROM campus_push_devices WHERE owner_id=$1',['reminder_a']);assert.equal(remaining.rows.length,0);mode='ok';
  });
  await t.test('cancelling a watch stops new messages and current authorization is checked on read and export',async()=>{
   await data('reminder_a','reminders.watch.remove',{id:watchId});advance(1000);await put('watch_cancelled','比赛已取消关注');advance(61000);
   assert.ok(!(await data('reminder_a','reminders.state')).notifications.some((n:any)=>n.itemId==='watch_cancelled'));
   const state=await data('reminder_a','reminders.save',{schoolId:'bjtu',itemId:'reminder_private',label:'私人事项',dueAt:new Date(Math.floor((clock+86400000)/60000)*60000).toISOString(),days:[0]});
   const own=state.reminders[0],file=await data('reminder_a','reminders.export',{id:own.id});assert.match(file.content,/BEGIN:VALARM/);assert.match(file.content,/TRIGGER:-PT0H/);assert.match(file.content,/DTSTART:\d{8}T\d{6}Z/);assert.ok(file.content.split('\r\n').every((line:string)=>Buffer.byteLength(line)<=75));
   assert.equal((await call('reminder_b','reminders.export',{id:own.id})).ok,false);
   await db.collection('items').doc('reminder_private').update({ownerOpenid:'reminder_b'});
   assert.equal((await call('reminder_a','reminders.export',{id:own.id})).ok,false);
   assert.ok(!(await data('reminder_a','reminders.state')).reminders.some((r:any)=>r.id===own.id));
  });
  await t.test('one browser endpoint can belong to only one account and unsubscribe cannot remove another account device',async()=>{
   await data('reminder_a','reminders.push.subscribe',{subscription:dev});await data('reminder_b','reminders.push.subscribe',{subscription:dev});
   await data('reminder_a','reminders.push.unsubscribe',{endpoint:dev.endpoint});
   const {rows}=await pool.query('SELECT owner_id FROM campus_push_devices');assert.deepEqual(rows.map(row=>row.owner_id),['reminder_b']);
  });
  await t.test('daily cleanup removes only expired reminder data and keeps watch settings and unrelated profile fields',async()=>{
   const expired=new Date(clock-91*86400000).toISOString(),fresh=new Date(clock).toISOString();
   const notification={id:'old',kind:'deadline',title:'旧提醒',message:'旧',schoolId:'bjtu',itemId:'reminder_public',createdAt:expired,read:false,sent:{}};
   await pool.query('UPDATE campus_reminder_accounts SET body=$2::jsonb WHERE owner_id=$1',['reminder_a',JSON.stringify({reminders:[{id:'old',dueAt:expired}],watches:[{id:'kept',schoolId:'bjtu'}],notifications:[notification,{...notification,id:'fresh',createdAt:fresh}]})]);
   await pool.query('UPDATE campus_push_devices SET updated_at=$1',[new Date(clock-181*86400000).toISOString()]);
   await cleanupReminderData(pool,clock);
   const {rows}=await pool.query('SELECT body FROM campus_reminder_accounts WHERE owner_id=$1',['reminder_a']);assert.equal(rows[0].body.reminders.length,0);assert.deepEqual(rows[0].body.notifications.map((n:any)=>n.id),['fresh']);assert.equal(rows[0].body.watches[0].id,'kept');
   assert.equal((await pool.query('SELECT endpoint_hash FROM campus_push_devices')).rows.length,0);assert.equal(await repo.selectedSchool('reminder_a'),'bjtu');
  });
 }finally{await nativePool.end();await server.stop();}
});
