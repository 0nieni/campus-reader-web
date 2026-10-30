import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import {postgresStorage,type SqlPool} from '../src/postgres-storage';
import {noticeBriefJobs} from '../src/notice-brief-jobs';
import {materialArchive} from '../src/material-archive';
import type {ItemRow} from '../src/repository';
const text='符合条件的同学可以报名本次校园活动，请按公告要求准备并提交材料。';
const output=()=>JSON.stringify({audience:{text,evidence:[{paragraphId:'p0001',quote:text}]},keyDates:[],requirements:[]});
test('history backfill uses durable local SQL and the existing independent model budget',async t=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),native=getDatabase({connectionString}).pool;(native as any).options.max=1;const pool=native as unknown as SqlPool,db=postgresStorage(pool);
 let clock=Date.parse('2026-10-30T04:00:00Z'),reads=0,calls=0,dispatches=0;
 const model=()=>({connection:{provider:'deepseek' as const,model:'synthetic',apiKey:'never-sent'},endpoint:'https://api.deepseek.com/chat/completions'});
 const reset=async()=>{for(const table of ['campus_notice_briefs','campus_notice_brief_budget','campus_notice_brief_workers','campus_notice_brief_backfill'])await pool.query('DELETE FROM '+table);await pool.query("DELETE FROM campus_documents WHERE collection IN ('items','sources')");reads=0;calls=0;dispatches=0;clock=Date.parse('2026-10-30T04:00:00Z');for(const id of ['school-a','school-b','global'])await db.collection('sources').doc('source-'+id).set({scope:id==='global'?'global':'school',schoolIds:[id],enabled:true,aiProcessing:'allow'});};
 const put=async(id:string,school='school-a',extra:Partial<ItemRow>={})=>{const row:ItemRow={_id:id,title:'原标题保留',scope:school==='global'?'global':'school',schoolIds:[school],sourceId:'source-'+school,status:'published',publishedAt:'2026-09-01T00:00:00Z',originalUrl:'https://example.test/'+id,...extra};await db.collection('items').doc(id).set(row);return row;};
 const article=async(row:ItemRow)=>{reads++;await db.collection('items').doc(row._id).update({contentText:text});return text;};
 const complete=async()=>{calls++;return{text:output(),usage:{inputTokens:30,outputTokens:20,totalTokens:50}};};
 const options=(extra:Record<string,unknown>={})=>({scope:'history',now:()=>clock,enabled:()=>true,model,article,complete,dispatch:async()=>{dispatches++;},...extra});
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
  await t.test('disabled flag and ordinary detail reads do not scan, collect or call a model',async()=>{
   await reset();const row=await put('a-disabled','school-a',{contentText:text}),jobs=noticeBriefJobs(pool,options({enabled:()=>false}));await jobs.wake();await jobs.run();await jobs.get(row,'school-a');assert.equal(reads,0);assert.equal(calls,0);assert.equal(dispatches,0);assert.equal((await pool.query('SELECT * FROM campus_notice_brief_backfill')).rows.length,0);
  });
  await t.test('all schools and global history are included, with private, mail, expired and denied data excluded',async()=>{
   await reset();for(const [id,school] of [['a-history','school-a'],['b-history','school-b'],['c-history','global']])await put(id!,school!);
   await put('private','school-a',{ownerOpenid:'another-person',scope:'private'});await put('mail','school-a',{categories:['mail']});await put('expired','school-a',{publishedAt:'2020-01-01'});await put('import-only','school-a',{aiProcessing:'import_only'});await put('search','school-a',{aiSearchExpiresAt:'2026-11-01'});
   await db.collection('sources').doc('denied').set({scope:'global',allowAi:false});await put('denied','global',{sourceId:'denied'});
   const jobs=noticeBriefJobs(pool,options());await jobs.wake();assert.equal(dispatches,1,'An empty model queue must still bootstrap history');await jobs.run();assert.equal(reads,3);assert.equal(calls,3);
   const rows=(await pool.query("SELECT item_id,school_id,state FROM campus_notice_briefs ORDER BY item_id")).rows;assert.deepEqual(rows.map(row=>[row.item_id,row.school_id,row.state]),[['a-history','school-a','ready'],['b-history','school-b','ready'],['c-history','global','ready']]);await jobs.run();assert.equal(reads,3);assert.equal(calls,3);assert.equal((await pool.query("SELECT id FROM campus_documents WHERE collection='web_ai_accounts'")).rows.length,0);
  });
  await t.test('cursor survives new worker instances and daily caps without rereading or recharging cached history',async()=>{
   await reset();for(const id of ['a','b','c'])await put(id);for(let day=0;day<3;day++){const jobs=noticeBriefJobs(pool,options({dailyCalls:1}));await jobs.run();assert.equal(calls,day+1);assert.equal(reads,day+1);assert.equal((await jobs.run()).more,false);assert.equal(calls,day+1);clock+=86400000;}
   await noticeBriefJobs(pool,options({dailyCalls:1})).run();assert.equal(calls,3);assert.equal(reads,3);assert.equal((await pool.query("SELECT sum(attempts) AS attempts FROM campus_notice_brief_budget")).rows[0].attempts,'3');
  });
  await t.test('permission is rechecked after article retrieval and uncertain results never auto-resend on later cycles',async()=>{
   await reset();await put('a-revoked');const revoked=noticeBriefJobs(pool,options({article:async(row:ItemRow)=>{await article(row);await db.collection('sources').doc('source-school-a').update({allowAi:false});return text;}}));await revoked.run();assert.equal(reads,1);assert.equal(calls,0);assert.equal((await pool.query('SELECT * FROM campus_notice_briefs')).rows.length,0);
   await reset();await put('a-uncertain');const opts=options({complete:async()=>{calls++;throw Object.assign(Error('Synthetic interruption'),{code:'MODEL_UNCERTAIN'});}});await noticeBriefJobs(pool,opts).run();clock+=86400000;await noticeBriefJobs(pool,opts).run();assert.equal(reads,1);assert.equal(calls,1);assert.equal((await pool.query('SELECT state FROM campus_notice_briefs')).rows[0].state,'uncertain');
  });
  await t.test('large backfills cannot exceed the hard 100 daily calls even with a larger configured limit',async()=>{
   await reset();for(let i=0;i<150;i++)await put('bulk-'+String(i).padStart(3,'0'));
   const jobs=noticeBriefJobs(pool,options({dailyCalls:1000}));await jobs.run();assert.equal(reads,100);assert.equal(calls,100);assert.equal((await jobs.run()).more,false);assert.equal(calls,100);
   clock+=86400000;await noticeBriefJobs(pool,options({dailyCalls:1000})).run();assert.equal(reads,150);assert.equal(calls,150);
  });
  await t.test('metadata-only pages resume after the per-worker scan bound instead of rescanning the same prefix',async()=>{
   await reset();await db.collection('sources').doc('source-school-a').update({allowAi:false});
   await pool.query("INSERT INTO campus_documents(collection,id,body) SELECT 'items','scan-'||lpad(n::text,4,'0'),jsonb_build_object('title','Synthetic','status','published','scope','school','schoolIds',jsonb_build_array('school-a'),'sourceId','source-school-a','publishedAt','2026-09-01') FROM generate_series(1,600) n");
   const jobs=noticeBriefJobs(pool,options());assert.equal((await jobs.run()).more,true);assert.equal((await pool.query('SELECT scanned FROM campus_notice_brief_backfill')).rows[0].scanned,500);assert.equal((await noticeBriefJobs(pool,options()).run()).more,false);assert.equal((await pool.query('SELECT scanned FROM campus_notice_brief_backfill')).rows[0].scanned,600);assert.equal(reads,0);assert.equal(calls,0);
  });
  await t.test('article failures have a daily read cap and do not create an empty dispatch loop',async()=>{
   await reset();await put('a-fails');await put('b-fails');const jobs=noticeBriefJobs(pool,options({dailyCalls:1,article:async()=>{reads++;throw Error('Synthetic unavailable page');}}));await jobs.run();assert.equal(reads,1);assert.equal(calls,0);const before=dispatches;assert.equal((await jobs.run()).more,false);await jobs.wake();assert.equal(dispatches,before);assert.equal(reads,1);clock+=86400000;await jobs.run();assert.equal(reads,2);
  });
  await t.test('concurrent workers share the history lease and do not duplicate model work',async()=>{
   await reset();await put('a-concurrent');let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;}),jobs=noticeBriefJobs(pool,options({article:async(row:ItemRow)=>{await blocked;return article(row);}}));const first=jobs.run();for(let i=0;i<100;i++){if((await pool.query('SELECT lease_id FROM campus_notice_brief_workers')).rows[0]?.lease_id)break;await new Promise(resolve=>setTimeout(resolve,5));}assert.equal((await jobs.run()).processed,0);release();await first;assert.equal(reads,1);assert.equal(calls,1);
  });
  await t.test('article-only history collection preserves attachments without downloading them or invoking the new-article hook',async()=>{
   await reset();const row=await put('a-archive'),objects=new Map<string,Uint8Array>();let downloads=0,hooks=0;
   const archive=materialArchive(pool,{put:async(key,data)=>{objects.set(key,data);},get:async key=>objects.get(key)||null,remove:async key=>{objects.delete(key);}},'history-article',{now:()=>clock,download:async()=>{downloads++;return{url:'https://example.test/file.pdf',bytes:new Uint8Array([1]),contentType:'application/pdf'};},extract:async()=>({state:'ready',text:'附件中的文本不能进入摘要',message:'Synthetic'}),onArticleSaved:async()=>{hooks++;}}),source={id:'school-a',name:'Synthetic',homepage:'https://example.test/',announcementUrl:'https://example.test/notices'};
   const reader=async(url:string)=>({url,html:'<article><p>'+text+'</p><a href="/file.pdf">材料.pdf</a></article>'});
   const first=await archive.collect(row,source,reader,{articleOnly:true});assert.equal(first.title,row.title);assert.equal(downloads,0);assert.equal(hooks,0);assert.equal(first.materialPending,true);assert.equal(first.contentText,text+'\n材料.pdf');
   await archive.collect(row,source,reader);assert.equal(downloads,1);const before=(await pool.query("SELECT blob_key FROM campus_material_files WHERE store_scope='history-article' AND kind='attachment'")).rows[0].blob_key;
   const final=await archive.collect(row,source,reader,{articleOnly:true});assert.equal(downloads,1);assert.ok(final.contentText?.includes('附件中的文本'));assert.equal((await pool.query("SELECT blob_key FROM campus_material_files WHERE store_scope='history-article' AND kind='attachment'")).rows[0].blob_key,before);
  });
 }finally{await native.end();await server.stop();}
});
