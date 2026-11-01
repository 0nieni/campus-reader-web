import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import {anonymousWorkspaces} from '../src/anonymous-workspace';
import type {SqlPool} from '../src/postgres-storage';
import {postgresStorage} from '../src/postgres-storage';
import {postgresRepository} from '../src/postgres-repository';
import {bookmarksService} from '../src/bookmarks';
import {createGateway} from '../src/gateway';
import {reminderEmail} from '../src/reminder-email';

test('guest credentials and single-use transfers use real SQL without copying account or delivery credentials',async t=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),native=getDatabase({connectionString}).pool;
 (native as any).options.max=1;const pool=native as unknown as SqlPool;let clock=Date.now();
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations/',import.meta.url)));
  const service=anonymousWorkspaces(pool,{now:()=>clock});
  const a=await service.create('synthetic-device-a'),b=await service.create('synthetic-device-b'),c=await service.create('synthetic-device-c');
  assert.notEqual(a.guest.owner,b.guest.owner);assert.match(a.token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await service.resolve(a.token))?.owner,a.guest.owner);assert.equal(await service.resolve('forged'),null);
  const stored=JSON.stringify((await pool.query('SELECT * FROM campus_guest_sessions')).rows);assert.ok(!stored.includes(a.token));
  const insert=async(collection:string,id:string,body:unknown)=>pool.query('INSERT INTO campus_documents(collection,id,body) VALUES($1,$2,$3::jsonb) ON CONFLICT(collection,id) DO UPDATE SET body=EXCLUDED.body',[collection,id,JSON.stringify(body)]);
  const publicItem={title:'Synthetic public notice',scope:'school',schoolIds:['bjtu'],sourceId:'guest-public-source',category:'competition',categories:['competition'],status:'published',publishedAt:new Date(clock).toISOString()};
  await insert('sources','guest-public-source',{scope:'school',schoolIds:['bjtu'],aiProcessing:'allow',name:'Synthetic public source'});
  await insert('items','guest-public-item',publicItem);
  await insert('items','guest-private-item',{...publicItem,scope:'private',ownerOpenid:'different-account',title:'PRIVATE MUST NOT TRANSFER'});
  await insert('user_profiles',a.guest.owner,{selectedSchoolId:'bjtu',webBookmarks:[{itemId:'guest-public-item',schoolId:'bjtu',savedAt:new Date(clock).toISOString()},{itemId:'guest-private-item',schoolId:'bjtu',savedAt:new Date(clock).toISOString()}],sourceFeedVisibility:{bjtu:{'guest-public-source':true}},hiddenFeedSources:{bjtu:[]},aiAssistant:{goals:'PRIVATE AI MEMORY'},secret:'PRIVATE EXTRA FIELD'});
  await insert('user_profiles',b.guest.owner,{untouched:'target metadata',webBookmarks:[]});
  await pool.query('INSERT INTO campus_notice_labels(owner_id,item_id,categories) VALUES($1,$2,$3::jsonb),($1,$4,$3::jsonb)',[a.guest.owner,'guest-public-item','["activity"]','guest-private-item']);
  const reminder={id:'syntheticreminder',itemId:'guest-public-item',schoolId:'bjtu',title:'Synthetic public notice',schoolName:'北京交通大学',label:'Synthetic deadline',dueAt:new Date(clock+86400000).toISOString(),days:[0],channels:{browser:true,email:true},generation:'old-generation',fired:[],createdAt:new Date(clock).toISOString()};
  await pool.query('INSERT INTO campus_reminder_accounts(owner_id,body) VALUES($1,$2::jsonb)',[a.guest.owner,JSON.stringify({reminders:[reminder],watches:[],notifications:[{id:'private-notification',message:'MUST NOT COPY'}]})]);
  await pool.query("INSERT INTO campus_reminder_email(owner_id,identity_id,email,binding_id,verified_at,enabled,created_at,updated_at,identity_kind) VALUES($1,$2,'fixture@example.test','sourcebinding',$3,true,$3,$3,'guest')",[a.guest.owner,a.guest.id,new Date(clock).toISOString()]);
  await t.test('copies only the allowed public data and consumes a transfer atomically',async()=>{
   const transfer=await service.generate(a.guest),result=await service.importCode(b.guest,transfer.code);
   assert.equal(result.bookmarks,1);assert.equal(result.reminders,1);assert.equal(result.tags,1);assert.equal(result.schoolId,'bjtu');
   assert.deepEqual(await service.importCode(b.guest,transfer.code),result,'same destination retry returns receipt');
   await assert.rejects(service.importCode(c.guest,transfer.code),(e:any)=>e.code==='TRANSFER_INVALID');
   const target=(await pool.query("SELECT body FROM campus_documents WHERE collection='user_profiles' AND id=$1",[b.guest.owner])).rows[0].body;
   assert.equal(target.untouched,'target metadata');assert.equal(target.aiAssistant,undefined);assert.equal(target.secret,undefined);assert.equal(target.webBookmarks.length,1);
   const imported=(await pool.query('SELECT body FROM campus_reminder_accounts WHERE owner_id=$1',[b.guest.owner])).rows[0].body;
   assert.equal(imported.notifications.length,0);assert.deepEqual(imported.reminders[0].channels,{browser:false,email:false});assert.notEqual(imported.reminders[0].id,reminder.id);
   assert.equal((await pool.query('SELECT * FROM campus_reminder_email WHERE owner_id=$1',[b.guest.owner])).rows.length,0);
   assert.equal((await pool.query('SELECT enabled FROM campus_reminder_email WHERE owner_id=$1',[a.guest.owner])).rows[0].enabled,true);
   assert.equal((await pool.query('SELECT * FROM campus_push_devices WHERE owner_id=$1',[b.guest.owner])).rows.length,0);
   assert.equal((await pool.query("SELECT body FROM campus_documents WHERE collection='user_profiles' AND id=$1",[a.guest.owner])).rows[0].body.secret,'PRIVATE EXTRA FIELD');
   assert.ok(!JSON.stringify((await pool.query('SELECT * FROM campus_guest_transfers')).rows).includes(transfer.code));
  });
  await t.test('new codes revoke old ones, cancellation and expiration cannot mutate destination data',async()=>{
   clock+=61000;const first=await service.generate(a.guest);clock+=61000;const second=await service.generate(a.guest);
   await assert.rejects(service.importCode(c.guest,first.code),(e:any)=>e.code==='TRANSFER_INVALID');
   await service.cancel(a.guest);await assert.rejects(service.importCode(c.guest,second.code),(e:any)=>e.code==='TRANSFER_INVALID');
   clock+=61000;const expired=await service.generate(a.guest);clock+=1800001;await assert.rejects(service.importCode(c.guest,expired.code),(e:any)=>e.code==='TRANSFER_INVALID');
   assert.equal((await pool.query("SELECT body FROM campus_documents WHERE collection='user_profiles' AND id=$1",[c.guest.owner])).rows.length,0);
  });
  await t.test('simultaneous redemption permits exactly one other workspace and limits generation',async()=>{
   const transfer=await service.generate(a.guest),d=await service.create('synthetic-device-d');
   const results=await Promise.allSettled([service.importCode(c.guest,transfer.code),service.importCode(d.guest,transfer.code)]);
   assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
   await assert.rejects(service.generate(a.guest),(e:any)=>e.code==='GUEST_RATE_LIMIT');
   await assert.rejects(service.importCode(a.guest,'not-a-code'),(e:any)=>e.code==='TRANSFER_INVALID');
  });
  await t.test('real guest reading and bookmark mutations remain isolated and exclude private notices',async()=>{
   const repo=postgresRepository(pool),db=postgresStorage(pool);
   const gateway=(owner:string)=>createGateway(repo,{ownerUid:owner,dataOwnerId:owner,guestWorkspace:true},()=>clock,{bookmarks:bookmarksService(db,repo)});
   const call=(owner:string,action:string,input:unknown)=>gateway(owner)({action,input},{uid:owner,isAnonymous:true});
   const publicDetail=await call(a.guest.owner,'feed.detail',{schoolId:'bjtu',itemId:'guest-public-item'});assert.ok(publicDetail.ok);
   const privateDetail=await call(a.guest.owner,'feed.detail',{schoolId:'bjtu',itemId:'guest-private-item'});assert.ok(!privateDetail.ok);
   assert.ok(!JSON.stringify(privateDetail).includes('PRIVATE MUST NOT TRANSFER'));
   const removed=await call(b.guest.owner,'favorites.set',{schoolId:'bjtu',itemId:'guest-public-item',saved:false});assert.ok(removed.ok);
   const source=(await pool.query("SELECT body FROM campus_documents WHERE collection='user_profiles' AND id=$1",[a.guest.owner])).rows[0].body;
   assert.equal(source.webBookmarks.length,2);
  });
  await t.test('merge caps roll back all writes and leave the code usable; existing destination choices win',async()=>{
   clock+=61000;const target=await service.create('synthetic-merge'),transfer=await service.generate(a.guest);
   const existing=Array.from({length:500},(_,i)=>({schoolId:'bjtu',itemId:'existing-'+i,savedAt:new Date(clock).toISOString()}));
   await insert('user_profiles',target.guest.owner,{selectedSchoolId:'other',webBookmarks:existing,sourceFeedVisibility:{bjtu:{'guest-public-source':false}}});
   await pool.query("INSERT INTO campus_reminder_accounts(owner_id) VALUES($1)",[target.guest.owner]);
   await pool.query("INSERT INTO campus_reminder_email(owner_id,identity_id,email,binding_id,verified_at,enabled,created_at,updated_at,identity_kind) VALUES($1,$2,'destination@example.test','targetbinding',$3,true,$3,$3,'guest')",[target.guest.owner,target.guest.id,new Date(clock).toISOString()]);
   await assert.rejects(service.importCode(target.guest,transfer.code),(e:any)=>e.code==='TRANSFER_LIMIT');
   assert.equal((await pool.query('SELECT enabled FROM campus_reminder_email WHERE owner_id=$1',[target.guest.owner])).rows[0].enabled,true);
   await insert('user_profiles',target.guest.owner,{webBookmarks:[],sourceFeedVisibility:{bjtu:{'guest-public-source':false}}});
   await pool.query('INSERT INTO campus_notice_labels(owner_id,item_id,categories) VALUES($1,$2,$3::jsonb)',[target.guest.owner,'guest-public-item','["academic"]']);
   const result=await service.importCode(target.guest,transfer.code);assert.equal(result.tags,0);assert.equal(result.bookmarks,1);
   const profile=(await pool.query("SELECT body FROM campus_documents WHERE collection='user_profiles' AND id=$1",[target.guest.owner])).rows[0].body;
   assert.equal(profile.sourceFeedVisibility.bjtu['guest-public-source'],false);assert.equal(profile.selectedSchoolId,'bjtu');
   const email=(await pool.query('SELECT * FROM campus_reminder_email WHERE owner_id=$1',[target.guest.owner])).rows[0];assert.equal(email.verified_at,null);assert.equal(email.enabled,false);assert.equal(email.email,'destination@example.test');
   await pool.query('UPDATE campus_reminder_email SET verified_at=$2 WHERE owner_id=$1',[target.guest.owner,new Date(clock).toISOString()]);
   await service.importCode(target.guest,transfer.code);assert.ok((await pool.query('SELECT verified_at FROM campus_reminder_email WHERE owner_id=$1',[target.guest.owner])).rows[0].verified_at,'receipt retry must not invalidate a subsequent verification');
  });
  await t.test('a full 500-bookmark and 500-label collection imports in a bounded number of SQL round trips',async()=>{
   const source=await service.create('synthetic-full-source'),target=await service.create('synthetic-full-target');
   const rows=Array.from({length:500},(_,i)=>({itemId:'bulk-'+i,schoolId:'bjtu',savedAt:new Date(clock).toISOString()}));
   await pool.query("INSERT INTO campus_documents(collection,id,body) SELECT 'items',x.\"itemId\",$2::jsonb FROM jsonb_to_recordset($1::jsonb) AS x(\"itemId\" text)",[JSON.stringify(rows),JSON.stringify(publicItem)]);
   await insert('user_profiles',source.guest.owner,{selectedSchoolId:'bjtu',webBookmarks:rows});
   await pool.query('INSERT INTO campus_notice_labels(owner_id,item_id,categories) SELECT $1,x."itemId",\'["activity"]\'::jsonb FROM jsonb_to_recordset($2::jsonb) AS x("itemId" text)',[source.guest.owner,JSON.stringify(rows)]);
   const transfer=await service.generate(source.guest);let queries=0;
   const counted:SqlPool={query:(sql,args)=>{queries++;return pool.query(sql,args);},connect:async()=>{const client=await pool.connect();return{query:(sql,args)=>{queries++;return client.query(sql,args);},release:()=>client.release()};}};
   const result=await anonymousWorkspaces(counted,{now:()=>clock}).importCode(target.guest,transfer.code);assert.equal(result.bookmarks,500);assert.equal(result.tags,500);assert.ok(queries<40,`migration issued ${queries} SQL round trips`);
  });
  await t.test('guest reminder mail proves the typed address independently, stays opt-in and caps a recipient across identities',async()=>{
   const target=await service.create('synthetic-mail'),messages:string[]=[];
   const mail=reminderEmail(pool,{now:()=>clock,resolveIdentity:async()=>{throw Error('guest must not resolve a Netlify account');},sender:{send:async(_to,_subject,text)=>{messages.push(text);return{state:'accepted'};}}});
   await assert.rejects(mail.bindGuest('guest_'+'0'.repeat(32),'fixture@example.test'),(e:any)=>e.code==='UNAUTHENTICATED');
   const state=await mail.bindGuest(target.guest.owner,' typed@example.test ');assert.equal(state.identityKind,'guest');assert.equal(state.verified,false);assert.equal(state.enabled,false);
   await assert.rejects(mail.handle('reminders.email.enable',{enabled:true},target.guest.owner),(e:any)=>e.code==='EMAIL_NOT_READY');
   await mail.handle('reminders.email.verify',{},target.guest.owner);const token=messages.at(-1)!.match(/#verify=([a-f0-9]{64})/)![1];
   assert.ok(!JSON.stringify((await pool.query('SELECT * FROM campus_reminder_email WHERE owner_id=$1',[target.guest.owner])).rows).includes(token));
   await mail.consume('verify',token);assert.equal((await mail.state(target.guest.owner)).enabled,false);assert.equal(await mail.verifiedAddress(target.guest.owner),'typed@example.test');
   await mail.handle('reminders.email.enable',{enabled:true},target.guest.owner);assert.equal((await mail.state(target.guest.owner)).enabled,true);
   clock+=61000;await mail.bindGuest(target.guest.owner,'changed@example.test');assert.equal((await mail.state(target.guest.owner)).verified,false);assert.equal((await mail.state(target.guest.owner)).enabled,false);assert.equal(await mail.verifiedAddress(target.guest.owner),null);
   await assert.rejects(mail.consume('verify',token));
   for(let i=0;i<3;i++){const other=await service.create('synthetic-mail-'+i);await mail.bindGuest(other.guest.owner,'quota@example.test');await mail.handle('reminders.email.verify',{},other.guest.owner);}
   const over=await service.create('synthetic-mail-over');await mail.bindGuest(over.guest.owner,'quota@example.test');
   await assert.rejects(mail.handle('reminders.email.verify',{},over.guest.owner),(e:any)=>e.code==='EMAIL_LIMIT');assert.equal(messages.length,4);
  });
 }finally{await native.end();await server.stop();}
});
