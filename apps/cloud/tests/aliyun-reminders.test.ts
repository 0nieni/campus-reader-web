import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createECDH,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import {postgresStorage,type SqlPool} from '../src/postgres-storage';
import {postgresRepository} from '../src/postgres-repository';
import {createGateway} from '../src/gateway';
import {reminderService,runReminderTick} from '../src/reminders';
import {reminderEmail,reminderOrigin} from '../src/reminder-email';
import {createEmailPage} from '../src/reminder-email-page';
import {directMailConfig,directMailSender,type MailResult} from '../src/directmail';
import {replaceWake,type WakeStore,type WakeValue,minuteTick} from '../src/reminder-index';
import {reminderPushMessage,type PushMessage} from '../src/browser-push';
function memoryWake():WakeStore {let value:WakeValue|null=null,version=0;return{async read(){return value?{value:structuredClone(value),etag:String(version)}:null;},async write(next,etag){if(etag!==(value?String(version):null))return false;value=structuredClone(next);version++;return true;}};}
const device=()=>{const ec=createECDH('prime256v1');ec.generateKeys();return{endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-aliyun',keys:{p256dh:ec.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};};
test('mail configuration is explicit, region/version matched, capped and independent from VAPID',()=>{
 const config={REMINDER_EMAIL_ENABLED:'true',DIRECTMAIL_ACCESS_KEY_ID:'synthetic-id',DIRECTMAIL_ACCESS_KEY_SECRET:'synthetic-secret',DIRECTMAIL_REGION:'cn-hangzhou',DIRECTMAIL_ACCOUNT_NAME:'notify@example.test'};
 assert.equal(directMailConfig(name=>(config as any)[name])?.dailyLimit,150);
 assert.equal(directMailConfig(name=>name==='DIRECTMAIL_REGION'?'ap-southeast-1':(config as any)[name]),undefined);
 assert.equal(directMailConfig(name=>name==='REMINDER_EMAIL_DAILY_LIMIT'?'151':(config as any)[name]),undefined);
 // Construct the real official SDK with dummy credentials without calling it.
 assert.equal(typeof directMailSender(directMailConfig(name=>(config as any)[name])!).send,'function');
});
test('official mail request is single-recipient, tracking-free and never hides unknown outcomes behind automatic retries',async()=>{
 const config={accessKeyId:'synthetic-id',accessKeySecret:'synthetic-secret',region:'cn-hangzhou',accountName:'notify@example.test',fromAlias:'校园阅览室',dailyLimit:150};let mode='ok',request:any,runtime:any;
 const sender=directMailSender(config,{async singleSendMailWithOptions(r:any,options:any){request=r;runtime=options;if(mode==='network')throw Error('synthetic transport failure');if(mode==='temporary')throw{statusCode:503,code:'ServiceUnavailable'};if(mode==='invalid')throw{statusCode:400,code:'InvalidToAddress.Spam'};return{body:{envId:'synthetic-provider-id'}} as any;},async senderStatisticsDetailByParamWithOptions(){return{body:{data:{mailDetail:[{toAddress:'one@example.test',accountName:config.accountName,status:2}]}}} as any;}});
 assert.deepEqual(await sender.send('one@example.test','校园阅览室｜测试','通用测试正文'),{state:'accepted',id:'synthetic-provider-id'});assert.equal(request.toAddress,'one@example.test');assert.equal(request.clickTrace,'0');assert.equal(request.replyToAddress,false);assert.equal(runtime.autoretry,false);assert.equal(runtime.maxAttempts,1);assert.equal(runtime.readTimeout,3500);
 mode='network';assert.equal((await sender.send('one@example.test','测试','通用')).state,'unknown');mode='temporary';assert.equal((await sender.send('one@example.test','测试','通用')).state,'temporary');mode='invalid';assert.equal((await sender.send('one@example.test','测试','通用')).invalid,true);assert.equal(await sender.suppressed!('one@example.test',Date.now()-86400000),true);
});
test('email links do not consume tokens on GET or in preview and require a same-origin explicit confirmation',async()=>{
 let calls=0;const handler=createEmailPage({production:()=>true,consume:async()=>{calls++;}}),url=reminderOrigin+'/.netlify/functions/reminder-email';
 const get=await handler(new Request(url));assert.equal(get.status,200);assert.equal(calls,0);assert.equal(get.headers.get('referrer-policy'),'no-referrer');assert.ok(get.headers.get('content-security-policy')?.includes("default-src 'none'"));
 const post=(origin:string)=>new Request(url,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({kind:'verify',token:'a'.repeat(64)})});
 assert.equal((await handler(post('https://evil.test'))).status,403);assert.equal(calls,0);
 assert.equal((await handler(post(reminderOrigin))).status,200);assert.equal(calls,1);
 const preview=createEmailPage({production:()=>false,consume:async()=>{calls++;}});assert.equal((await preview(post(reminderOrigin))).status,503);assert.equal(calls,1);
});
test('FC scheduling, independent channels, verification, quota and recovery use only synthetic SQL and senders',async t=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),database=getDatabase({connectionString}),native=database.pool;
 (native as any).options.max=1;const pool=native as unknown as SqlPool,repo=postgresRepository(pool),db=postgresStorage(pool),index=memoryWake();
 let clock=Math.floor(Date.now()/60000)*60000,counter=0,mode:MailResult['state']='accepted',invalid=false,pushMode='accepted',suppressed=false,identityAvailable=true,throwMail=false;
 const addresses=new Map([['fc_a','a@example.test'],['fc_b','b@example.test']]),messages:{to:string;subject:string;text:string}[]=[],pushes:string[]=[],pushMessages:(PushMessage|undefined)[]=[];
 const mail=reminderEmail(pool,{now:()=>clock,resolveIdentity:async id=>{if(!identityAvailable)throw Error('synthetic outage');return{email:addresses.get(id)};},sender:{send:async(to,subject,text)=>{messages.push({to,subject,text});if(throwMail)throw Error('synthetic interruption after request');return{state:mode,id:mode==='accepted'?'synthetic-env-'+messages.length:undefined,invalid};},suppressed:async()=>suppressed}});
 const options={now:()=>clock,minuteMode:true,aliyun:{index,email:mail},push:{publicKey:'synthetic-public',privateKey:'synthetic-private',subject:reminderOrigin},send:async(subscription:any,_config:unknown,_tag:string,message?:PushMessage)=>{pushes.push(subscription.endpoint);pushMessages.push(message);if(pushMode!=='accepted')throw Object.assign(Error('synthetic push'),pushMode==='temporary'?{statusCode:503}:{});}};
 const service=reminderService(pool,options),identity=(owner='fc_a')=>({uid:owner,dataOwnerId:owner,legacyLinked:false});
 const call=async(action:string,input:Record<string,unknown>={},owner='fc_a')=>{const result=await createGateway(repo,{ownerUid:owner,dataOwnerId:owner},()=>clock,{reminders:service})({action,input},{uid:owner,isAnonymous:false});assert.ok(result.ok,JSON.stringify(result));return result.data as any;};
 const save=async(channels={browser:false,email:true},owner='fc_a',minutes=5,days=[0])=>{
  const itemId='aliyun_item_'+(++counter);await db.collection('items').doc(itemId).set({title:'合成不可外发公告标题'+counter,scope:'school',schoolIds:['bjtu'],status:'published',publishedAt:new Date(clock).toISOString(),createdAt:new Date(clock).toISOString(),categories:['school'],sourceId:'synthetic_source'});
  const state=await call('reminders.save',{schoolId:'bjtu',itemId,label:'合成不可外发事项名称',dueAt:new Date(clock+minutes*60000).toISOString(),days,channels},owner);return state.reminders.find((r:any)=>r.itemId===itemId);
 };
 const clear=async()=>{for(const owner of ['fc_a','fc_b'])for(const row of (await call('reminders.state',{},owner)).reminders)await call('reminders.remove',{id:row.id},owner);};
 const tick=()=>minuteTick({store:index,now:()=>clock,process:()=>service.aliyun!.tick({budgetMs:90000})});
 async function verify(owner='fc_a'){
  await mail.bind(owner,owner,addresses.get(owner)!);await mail.handle('reminders.email.verify',{},owner);const token=messages.at(-1)!.text.match(/#verify=([a-f0-9]{64})/)![1];await mail.consume('verify',token);return token;
 }
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
  for(const owner of ['fc_a','fc_b']){await repo.selectSchool(owner,'bjtu');await mail.bind(owner,owner,addresses.get(owner)!);}
  await t.test('new account mail defaults off and verification never enables or accepts arbitrary recipients',async()=>{
   assert.equal((await mail.state('fc_a')).enabled,false);const token=await verify();assert.equal((await mail.state('fc_a')).verified,true);assert.equal((await mail.state('fc_a')).enabled,false);
   await assert.rejects(mail.consume('verify',token));await assert.rejects(mail.handle('reminders.email.test',{},'fc_a'));
   const result=await createGateway(repo,{ownerUid:'fc_a',dataOwnerId:'fc_a'},()=>clock,{reminders:service})({action:'reminders.email.verify',input:{to:'evil@example.test'}},{uid:'fc_a',isAnonymous:false});assert.equal(result.ok,false);
   await mail.handle('reminders.email.enable',{enabled:true},'fc_a');
   await service.aliyun!.register();assert.equal((await index.read())!.value.nextAt,null,'enabled mail without accepted sends must not schedule SQL maintenance');
  });
  await t.test('mail-only users receive the selected announcement and deadline independently of inbox read state',async()=>{
   const r=await save(),state=await call('reminders.state');assert.equal(state.deviceCount,0);assert.equal(r.channelDelivery.email.status,'scheduled');
   assert.ok((await index.read())!.value.nextAt!<=Date.parse(r.dueAt));clock=Date.parse(r.dueAt)+1000;await call('reminders.read',{});const before=messages.length;
   const noPush=reminderService(pool,{...options,push:undefined});await noPush.aliyun!.tick({budgetMs:90000});assert.equal(messages.length,before+1);assert.equal(pushes.length,0);assert.ok(messages.at(-1)!.text.includes(r.title));assert.ok(messages.at(-1)!.text.includes(reminderPushMessage(r).body));await tick();assert.equal(messages.length,before+1);
   assert.equal((await noPush.handle('reminders.state',{},identity()) as any).reminders[0].channelDelivery.email.status,'accepted');
  });
  await t.test('verification and test attempts consume quota with 60-second and three-per-day verification limits',async()=>{
   await mail.handle('reminders.email.verify',{},'fc_a');await assert.rejects(mail.handle('reminders.email.verify',{},'fc_a'));clock+=61000;await mail.handle('reminders.email.verify',{},'fc_a');clock+=61000;await assert.rejects(mail.handle('reminders.email.verify',{},'fc_a'));
   await mail.handle('reminders.email.test',{},'fc_a');await assert.rejects(mail.handle('reminders.email.test',{},'fc_a'));assert.ok((await mail.state('fc_a')).usedToday>=5);
  });
  await t.test('both channels finish separately and a confirmed temporary mail failure retries without duplicating browser delivery',async()=>{
   await clear();await call('reminders.push.subscribe',{subscription:device()});const r=await save({browser:true,email:true}),beforeMail=messages.length,beforePush=pushes.length;clock=Date.parse(r.dueAt)+1000;mode='temporary';await tick();
   assert.equal(messages.length,beforeMail+1);assert.equal(pushes.length,beforePush+1);assert.deepEqual(pushMessages.at(-1),reminderPushMessage(r));let state=await call('reminders.state');assert.equal(state.reminders[0].channelDelivery.browser.status,'accepted');assert.equal(state.reminders[0].channelDelivery.email.status,'retrying');
   clock+=61000;mode='accepted';await tick();assert.equal(messages.length,beforeMail+2);assert.equal(pushes.length,beforePush+1);await tick();assert.equal(messages.length,beforeMail+2);
  });
  await t.test('unknown email outcomes are durable and never automatically resent',async()=>{
   await clear();const r=await save(),before=messages.length;mode='unknown';clock=Date.parse(r.dueAt)+1000;await tick();clock+=300000;await tick();assert.equal(messages.length,before+1);assert.equal((await call('reminders.state')).reminders[0].channelDelivery.email.status,'unknown');mode='accepted';
  });
  await t.test('a sender exception after request initiation is unknown, and an Identity outage postpones mail without swallowing browser',async()=>{
   await clear();let r=await save(),before=messages.length;throwMail=true;clock=Date.parse(r.dueAt)+1000;await tick();throwMail=false;clock+=300000;await tick();assert.equal(messages.length,before+1);assert.equal((await call('reminders.state')).reminders[0].channelDelivery.email.status,'unknown');
   await clear();r=await save({browser:true,email:true});before=messages.length;const beforePush=pushes.length;identityAvailable=false;clock=Date.parse(r.dueAt)+1000;await tick();assert.equal(messages.length,before);assert.equal(pushes.length,beforePush+1);identityAvailable=true;clock+=301000;await tick();assert.equal(messages.length,before+1);assert.equal(pushes.length,beforePush+1);
  });
  await t.test('cancel, edit, revoked announcement permission and both channels off cannot send old external messages',async()=>{
   await clear();let r=await save(),before=messages.length;await call('reminders.remove',{id:r.id});clock=Date.parse(r.dueAt)+1000;await tick();assert.equal(messages.length,before);
   r=await save();await call('reminders.save',{id:r.id,schoolId:r.schoolId,itemId:r.itemId,label:r.label,dueAt:new Date(Date.parse(r.dueAt)+3600000).toISOString(),days:[0],channels:{browser:false,email:true}});clock=Date.parse(r.dueAt)+1000;await tick();assert.equal(messages.length,before);
   await clear();r=await save();await db.collection('items').doc(r.itemId).update({status:'withdrawn'});clock=Date.parse(r.dueAt)+1000;await tick();assert.equal(messages.length,before);
   r=await save({browser:false,email:false});clock=Date.parse(r.dueAt)+1000;await tick();assert.equal(messages.length,before);assert.ok((await call('reminders.state')).notifications.length>0);
  });
  await t.test('closing mail or changing the authoritative account address blocks pending sends and invalidates old links',async()=>{
   await clear();let r=await save(),before=messages.length;await mail.handle('reminders.email.enable',{enabled:false},'fc_a');clock=Date.parse(r.dueAt)+1000;await tick();assert.equal(messages.length,before);
   await mail.handle('reminders.email.enable',{enabled:true},'fc_a');r=await save();addresses.set('fc_a','changed@example.test');clock=Date.parse(r.dueAt)+1000;await tick();assert.equal(messages.length,before);assert.equal((await mail.state('fc_a')).verified,false);assert.equal((await mail.state('fc_a')).enabled,false);
   addresses.set('fc_a','a@example.test');await mail.bind('fc_a','fc_a','a@example.test');clock+=86400000;await verify();await mail.handle('reminders.email.enable',{enabled:true},'fc_a');
  });
  await t.test('daily repair restores failed index registration, distant dates have no QStash horizon or reservation cap',async()=>{
   await clear();const broken:WakeStore={read:()=>index.read(),async write(){throw Error('synthetic storage failure');}};
   const failing=reminderService(pool,{...options,aliyun:{...options.aliyun,index:broken}});const r=await save({browser:false,email:true},'fc_a',60*24*60);
   assert.equal(r.channelDelivery.email.status,'scheduled');await pool.query('UPDATE campus_reminder_jobs SET registered_at=NULL WHERE reminder_id=$1',[r.id]);
   const state=await failing.handle('reminders.state',{},identity()) as any;assert.equal(state.reminders[0].channelDelivery.email.status,'registration_failed');await runReminderTick(pool,options);assert.equal((await call('reminders.state')).reminders[0].channelDelivery.email.status,'scheduled');
   assert.equal((await pool.query('SELECT count(*)::integer AS n FROM campus_reminder_queue_budget')).rows[0].n,0);
  });
  await t.test('bounce or complaint feedback pauses mail without disabling available browser push',async()=>{
   suppressed=true;assert.equal((await mail.feedback()).suspended,1);assert.equal((await mail.state('fc_a')).suspended,true);suppressed=false;
   await clear();clock+=86400000;await verify();await mail.handle('reminders.email.enable',{enabled:true},'fc_a');invalid=true;mode='failed';const r=await save({browser:true,email:true}),before=pushes.length;clock=Date.parse(r.dueAt)+1000;await tick();assert.equal(pushes.length,before+1);assert.equal((await mail.state('fc_a')).suspended,true);invalid=false;mode='accepted';
  });
  await t.test('global mail cap is transactional and does not swallow independent browser requests',async()=>{
   await clear();clock+=86400000;await verify();await mail.handle('reminders.email.enable',{enabled:true},'fc_a');const r=await save({browser:true,email:true}),before=messages.length,beforePush=pushes.length;
   const date=new Date(clock+8*3600000).toISOString().slice(0,10);await pool.query("INSERT INTO campus_reminder_email_budget(day,owner_id,kind,used) VALUES($1,'*','all',150) ON CONFLICT(day,owner_id,kind) DO UPDATE SET used=150",[date]);clock=Date.parse(r.dueAt)+1000;await tick();assert.equal(messages.length,before);assert.equal(pushes.length,beforePush+1);assert.equal((await call('reminders.state')).reminders[0].channelDelivery.email.status,'limited');
  });
  await t.test('other accounts cannot change or export this account reminder and old unsubscribe links remain binding-specific',async()=>{
   const r=(await call('reminders.state')).reminders[0];
   const result=await createGateway(repo,{ownerUid:'fc_b',dataOwnerId:'fc_b'},()=>clock,{reminders:service})({action:'reminders.save',input:{id:r.id,schoolId:r.schoolId,itemId:r.itemId,label:r.label,dueAt:new Date(clock+600000).toISOString(),days:[0],channels:{browser:true,email:true}}},{uid:'fc_b',isAnonymous:false});assert.equal(result.ok,false);
   assert.equal((await call('reminders.state',{},'fc_b')).reminders.length,0);
   const row=(await pool.query("SELECT binding_id FROM campus_reminder_email WHERE owner_id='fc_a'")).rows[0],link=await mail.unsubscribeLink('fc_a',row.binding_id),second=await mail.unsubscribeLink('fc_a',row.binding_id);assert.equal(link,second);
   await mail.consume('unsubscribe',link!.split('=')[1]);assert.equal((await mail.state('fc_a')).enabled,false);
  });
  await t.test('recovery skips offsets older than 24 hours and coalesces multiple crossed offsets',async()=>{
   await clear();let r=await save({browser:true,email:false}),before=pushes.length;clock=Date.parse(r.dueAt)+86400000+1000;await tick();assert.equal(pushes.length,before);
   r=await save({browser:true,email:false},'fc_a',8*1440,[7,3,1,0]);clock=Date.parse(r.dueAt)+1000;await tick();assert.equal(pushes.length,before+1);
  });
  await t.test('interrupted durable claims and concurrent ticks never resend an uncertain browser request',async()=>{
   await clear();let r=await save({browser:true,email:false}),before=pushes.length;
   const job=(await pool.query('SELECT id FROM campus_reminder_jobs WHERE reminder_id=$1',[r.id])).rows[0],binding=(await pool.query("SELECT endpoint_hash,binding_id FROM campus_push_devices WHERE owner_id='fc_a'")).rows[0];
   clock=Date.parse(r.dueAt)+1000;await pool.query("UPDATE campus_reminder_jobs SET state='processing',lease_until=$2 WHERE id=$1",[job.id,new Date(clock-1000).toISOString()]);await pool.query("INSERT INTO campus_reminder_channel_receipts(job_id,channel,target_id,binding_id,state,created_at) VALUES($1,'browser',$2,$3,'sending',$4)",[job.id,binding.endpoint_hash,binding.binding_id,new Date(clock-2000).toISOString()]);await service.aliyun!.register();await tick();assert.equal(pushes.length,before);assert.equal((await call('reminders.state')).reminders[0].channelDelivery.browser.status,'unknown');
   await clear();r=await save({browser:true,email:false});clock=Date.parse(r.dueAt)+1000;await Promise.all([tick(),tick()]);assert.equal(pushes.length,before+1);
  });
  await t.test('an early reminder shows the actual deadline rather than the earlier sending time',async()=>{
   await clear();const r=await save({browser:true,email:false},'fc_a',2880,[1,0]);clock=Date.parse(r.dueAt)-86400000+1000;const before=pushes.length;await tick();
   assert.equal(pushes.length,before+1);assert.deepEqual(pushMessages.at(-1),reminderPushMessage(r));
  });
  await t.test('100 synthetic due tasks are bounded, resume without duplicate sends, and leave no SQL wake loop',async()=>{
   await clear();const before=pushes.length;
   for(let i=0;i<100;i++)await save({browser:true,email:false});clock+=5*60000+1000;
   const first=await service.aliyun!.tick({limit:25,budgetMs:90000});assert.equal(first.processed,25);assert.equal(pushes.length,before+25);
   await service.aliyun!.tick({limit:100,budgetMs:90000});assert.equal(pushes.length,before+100);assert.equal((await index.read())!.value.nextAt,null);await tick();assert.equal(pushes.length,before+100);
   const times=await pool.query("SELECT count(*)::integer AS count FROM campus_reminder_channel_receipts WHERE channel='browser' AND state='accepted' AND started_at IS NOT NULL");assert.ok(times.rows[0].count>=100);
  });
 }finally{await native.end();await server.stop();}
});
