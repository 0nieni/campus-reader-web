import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,createHmac,createECDH,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import {postgresStorage,type SqlPool} from '../src/postgres-storage';
import {postgresRepository} from '../src/postgres-repository';
import {createGateway} from '../src/gateway';
import {reminderService,runReminderTick} from '../src/reminders';
import {cleanupReminderData} from '../src/reminder-cleanup';
import {qstashConfig,qstashPublisher,createReminderCallback,reminderCallback} from '../src/qstash';

const config={token:'synthetic-token',currentSigningKey:'synthetic-current-signing-key-12345',nextSigningKey:'synthetic-next-signing-key-12345678',baseUrl:'https://qstash.upstash.io'};
function signature(body:string,key=config.currentSigningKey,claims={}){
 const time=Math.floor(Date.now()/1000),header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
 const payload=Buffer.from(JSON.stringify({iss:'Upstash',sub:reminderCallback,nbf:time-10,exp:time+120,body:createHash('sha256').update(body).digest('base64url'),...claims})).toString('base64url');
 const input=header+'.'+payload;return input+'.'+createHmac('sha256',key).update(input).digest('base64url');
}
const request=(body:string,token=signature(body),url=reminderCallback)=>new Request(url,{method:'POST',headers:{'content-type':'application/json','Upstash-Signature':token},body});
test('QStash publication contains only an opaque job ID, bounded time, one retry and no redirect',async()=>{
 const at=Date.now()+60000,id='a'.repeat(32);let sent:RequestInit|undefined,url='';
 const publisher=qstashPublisher(config,(async(input:any,init:any)=>{url=String(input);sent=init;return Response.json({messageId:'synthetic-message'});}) as typeof fetch);
 assert.equal(await publisher.publish(id,at),'synthetic-message');assert.equal(url,config.baseUrl+'/v2/publish/'+reminderCallback);
 assert.deepEqual(JSON.parse(sent!.body as string),{jobId:id});assert.equal(sent!.redirect,'error');
 const headers=sent!.headers as Record<string,string>;assert.equal(headers['Upstash-Not-Before'],String(Math.ceil(at/1000)));assert.equal(headers['Upstash-Retries'],'1');assert.equal(headers['Upstash-Deduplication-Id'],id);
 assert.equal(qstashConfig(()=>undefined),undefined);
 for(const base of ['not-a-url','https://evil.example','http://qstash.upstash.io','https://user:pass@qstash.upstash.io','https://qstash.upstash.io/evil','https://qstash.upstash.io:8443'])assert.equal(qstashConfig(name=>({QSTASH_TOKEN:'fake',QSTASH_CURRENT_SIGNING_KEY:'fake',QSTASH_NEXT_SIGNING_KEY:'fake',QSTASH_URL:base}[name])),undefined);
});
test('callback verifies raw-body signatures, rotation, expiry, destination and production before any task access',async()=>{
 let calls=0;const handler=createReminderCallback({config:()=>config,production:()=>true,deliver:async()=>{calls++;}}),raw=JSON.stringify({jobId:'b'.repeat(32)});
 for(const token of ['invalid',signature(raw,'wrong'),signature(raw,config.currentSigningKey,{exp:1}),signature(raw,config.currentSigningKey,{iss:'wrong'}),signature(raw,config.currentSigningKey,{sub:'https://evil.example'})])assert.equal((await handler(request(raw,token))).status,401);
 assert.equal((await handler(request(raw+' ',signature(raw)))).status,401);assert.equal((await handler(request(raw,signature(raw),reminderCallback+'?spoof=1'))).status,401);
 assert.equal((await handler(request('x'.repeat(257)))).status,413);assert.equal(calls,0);
 assert.equal((await handler(request(raw))).status,204);assert.equal((await handler(request(raw,signature(raw,config.nextSigningKey)))).status,204);assert.equal(calls,2);
 const preview=createReminderCallback({config:()=>config,production:()=>false,deliver:async()=>{throw Error('must not run');}});assert.equal((await preview(request(raw))).status,503);
});
const subscription=(endpoint:string)=>{const ec=createECDH('prime256v1');ec.generateKeys();return{endpoint,keys:{p256dh:ec.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};};
test('minute reminders persist a transactional outbox and deliver separately to Windows, Apple and Android devices',async t=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),database=getDatabase({connectionString}),native=database.pool;
 (native as any).options.max=1;const pool=native as unknown as SqlPool,repo=postgresRepository(pool),db=postgresStorage(pool);
 let clock=Math.floor(Date.now()/60000)*60000,publishFailure=false,sendMode:'ok'|'unknown'|'gone'='ok',counter=0;
 const published:{id:string;at:number}[]=[],sent:string[]=[];
 const queue={publish:async(id:string,at:number)=>{if(publishFailure)throw Error('synthetic outage');published.push({id,at});return'synthetic-message-'+id;}};
 const options={now:()=>clock,minuteMode:true,queue,push:{publicKey:'synthetic-public',privateKey:'synthetic-private',subject:'https://example.test'},send:async(device:any)=>{sent.push(device.endpoint);if(sendMode!=='ok')throw Object.assign(Error('synthetic'),sendMode==='gone'?{statusCode:410}:{});}};
 const service=reminderService(pool,options);
 const call=async(owner:string,action:string,input:Record<string,unknown>={})=>{const result=await createGateway(repo,{ownerUid:owner,dataOwnerId:owner},()=>clock,{reminders:service})({action,input},{uid:owner,isAnonymous:false});assert.ok(result.ok,JSON.stringify(result));return result.data as any;};
 const data=(action:string,input:Record<string,unknown>={})=>call('minute_a',action,input);
 const save=async(days=[0],minutes=5)=>{
  const itemId='minute_item_'+(++counter);await db.collection('items').doc(itemId).set({title:'合成分钟提醒'+counter,scope:'school',schoolIds:['bjtu'],status:'published',publishedAt:new Date(clock).toISOString(),createdAt:new Date(clock).toISOString(),categories:['school'],sourceId:'synthetic_source'});
  const result=await data('reminders.save',{schoolId:'bjtu',itemId,label:'报名截止',dueAt:new Date(clock+minutes*60000).toISOString(),days});return result.reminders.find((r:any)=>r.itemId===itemId);
 };
 const clear=async()=>{for(const r of (await data('reminders.state')).reminders)await data('reminders.remove',{id:r.id});};
 const job=async(reminderId:string,offset=0)=>(await pool.query('SELECT * FROM campus_reminder_jobs WHERE reminder_id=$1 AND offset_days=$2 ORDER BY created_at DESC',[reminderId,offset])).rows[0]!;
 const devices=[subscription('https://wns2-synthetic.notify.windows.com/fake'),subscription('https://synthetic.web.push.apple.com/fake'),subscription('https://fcm.googleapis.com/fcm/send/synthetic')];
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
  await repo.selectSchool('minute_a','bjtu');await repo.selectSchool('minute_b','bjtu');
  let first:any;
  await t.test('without a device tasks remain durable and no scheduled delivery is falsely reported',async()=>{
   first=await save();assert.equal(first.delivery.status,'no_device');assert.equal((await job(first.id)).state,'pending');assert.equal(published.length,0);
   const unavailable=reminderService(pool,{minuteMode:true,now:()=>clock});const state=await unavailable.handle('reminders.state',{}, {dataOwnerId:'minute_a'} as any) as any;assert.equal(state.queueConfigured,false);assert.equal(state.reminders[0].delivery.status,'unconfigured');
   await assert.rejects(service.handle('reminders.watch.save',{}, {dataOwnerId:'minute_a'} as any));
  });
  await t.test('each device opts in and a read inbox cannot swallow the independently scheduled system reminder',async()=>{
   for(const device of devices)await data('reminders.push.subscribe',{subscription:device});
   const state=await data('reminders.state');assert.equal(state.deviceCount,3);assert.equal(state.reminders[0].delivery.status,'scheduled');assert.equal(published.length,1);
   const task=await job(first.id);clock=Date.parse(first.dueAt)+1000;
   assert.equal((await data('reminders.state')).unread,1);await data('reminders.read');
   const result=await Promise.all([service.runJob(task.id),service.runJob(task.id)]);assert.equal(result.reduce((sum,r)=>sum+r.accepted,0),3);assert.equal(sent.length,3);assert.deepEqual(new Set(sent),new Set(devices.map(d=>d.endpoint)));
   await service.runJob(task.id);assert.equal(sent.length,3);assert.equal((await data('reminders.state')).reminders[0].delivery.status,'sent');
  });
  await t.test('editing and removal invalidate already-published task versions',async()=>{
   await clear();const reminder=await save(),old=await job(reminder.id),before=sent.length;
   const changed=await data('reminders.save',{id:reminder.id,schoolId:'bjtu',itemId:reminder.itemId,label:'改期',dueAt:new Date(clock+600000).toISOString(),days:[0]});
   clock=Date.parse(reminder.dueAt)+1000;await service.runJob(old.id);assert.equal(sent.length,before);
   const current=await job(reminder.id);await data('reminders.remove',{id:changed.reminders[0].id});clock=Date.parse(current.run_at)+1000;await service.runJob(current.id);assert.equal(sent.length,before);
  });
  await t.test('pre-upgrade expired reminders are not backfilled or shown as waiting forever',async()=>{
   await clear();clock=Math.ceil(clock/60000)*60000;const reminder=await save(),count=published.length;
   await pool.query('DELETE FROM campus_reminder_jobs WHERE reminder_id=$1',[reminder.id]);clock=Date.parse(reminder.dueAt)+1000;
   const state=await data('reminders.state');assert.equal(state.reminders[0].delivery.status,'finished');assert.equal(published.length,count);
  });
  await t.test('a QStash outage retains the outbox, shows failure and can be registered after recovery',async()=>{
   await clear();publishFailure=true;const reminder=await save([0],15);assert.equal(reminder.delivery.status,'registration_failed');assert.equal((await job(reminder.id)).state,'pending');
   publishFailure=false;clock+=301000;const state=await data('reminders.state');assert.equal(state.reminders[0].delivery.status,'scheduled');
   assert.equal((await job(reminder.id)).state,'queued');
  });
  await t.test('long dates roll into the six-day window through daily repair without minute SQL polling',async()=>{
   await clear();clock=Math.ceil(clock/60000)*60000;const count=published.length,reminder=await save([7,3,1,0],14*1440);assert.equal(reminder.delivery.status,'later');assert.equal(published.length,count);
   clock+=2*86400000;await runReminderTick(pool,options);assert.equal(published.length,count+1);assert.equal(published.at(-1)!.at,Date.parse(reminder.dueAt)-7*86400000);
  });
  await t.test('revoked source access and an endpoint transferred to another owner never receive the old task',async()=>{
   await clear();clock=Math.ceil(clock/60000)*60000;const reminder=await save(),task=await job(reminder.id),before=sent.length;
   await db.collection('items').doc(reminder.itemId).update({status:'withdrawn'});clock=Date.parse(reminder.dueAt)+1000;await service.runJob(task.id);assert.equal(sent.length,before);
   clock=Math.ceil(clock/60000)*60000;const next=await save(),nextJob=await job(next.id);await call('minute_b','reminders.push.subscribe',{subscription:devices[0]});clock=Date.parse(next.dueAt)+1000;await service.runJob(nextJob.id);
   assert.equal(sent.length,before+2);assert.ok(sent.slice(before).every(endpoint=>endpoint!==devices[0].endpoint));
  });
  await t.test('unknown push outcomes are durable and duplicate callbacks do not blindly retry',async()=>{
   await clear();clock=Math.ceil(clock/60000)*60000;const reminder=await save(),task=await job(reminder.id),before=sent.length;sendMode='unknown';clock=Date.parse(reminder.dueAt)+1000;
   await service.runJob(task.id);assert.equal(sent.length,before+2);await service.runJob(task.id);assert.equal(sent.length,before+2);assert.equal((await data('reminders.state')).reminders[0].delivery.status,'unknown');sendMode='ok';
  });
  await t.test('delivery-date budget reservations stop unlimited registration and remain consumed on cancellation',async()=>{
   await clear();clock=Math.ceil(clock/60000)*60000;const date=new Date(clock+600000).toISOString().slice(0,10);
   await pool.query('INSERT INTO campus_reminder_queue_budget(day,used) VALUES($1,400) ON CONFLICT(day) DO UPDATE SET used=400',[date]);
   const count=published.length,reminder=await save([0],10);assert.equal(published.length,count);assert.equal(reminder.delivery.status,'registration_failed');
   await data('reminders.remove',{id:reminder.id});assert.equal((await pool.query('SELECT used FROM campus_reminder_queue_budget WHERE day=$1',[date])).rows[0].used,400);
  });
  await t.test('cleanup removes expired job receipts but keeps future tasks',async()=>{
   await clear();clock=Math.ceil(clock/60000)*60000;const reminder=await save([0],30*1440),task=await job(reminder.id);
   await pool.query('UPDATE campus_reminder_jobs SET run_at=$2 WHERE id<>$1',[task.id,new Date(clock-91*86400000).toISOString()]);await cleanupReminderData(pool,clock);
   assert.deepEqual((await pool.query('SELECT id FROM campus_reminder_jobs')).rows.map(r=>r.id),[task.id]);
  });
 }finally{await native.end();await server.stop();}
});
