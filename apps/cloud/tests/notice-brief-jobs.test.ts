import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import {postgresStorage,type SqlPool} from '../src/postgres-storage';
import {noticeBriefJobs} from '../src/notice-brief-jobs';
import {prepareBrief} from '../src/notice-brief';
import {cleanupNoticeBriefs} from '../src/notice-brief-cleanup';
import {materialArchive} from '../src/material-archive';
const text='仅限符合要求的申报班级。\n请于2026年11月21日17:00前提交电子版材料，证明材料单独放在一个Word文件中。';
const output=(body=text)=>JSON.stringify({audience:{text:body.split('\n')[0],evidence:[{paragraphId:'p0001',quote:body.split('\n')[0]}]},keyDates:[],requirements:[]});
test('independent brief SQL queue, permissions, reservations and uncertain calls',async t=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),native=getDatabase({connectionString}).pool;(native as any).options.max=1;const pool=native as unknown as SqlPool,db=postgresStorage(pool);let clock=Date.parse('2026-10-30T04:00:00Z');
 const connection={provider:'deepseek' as const,model:'synthetic-model',apiKey:'synthetic-never-sent'},model=()=>({connection,endpoint:'https://api.deepseek.com/chat/completions'});
 const put=async(id:string,body=text)=>{await db.collection('items').doc(id).set({title:'保留的原标题',scope:'school',schoolIds:['bjtu'],sourceId:'brief_source',status:'published',publishedAt:'2026-10-18T00:00:00Z',contentText:body,originalUrl:'https://example.test/'+id});return{...(await pool.query("SELECT body FROM campus_documents WHERE collection='items' AND id=$1",[id])).rows[0].body,_id:id};};
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));await db.collection('sources').doc('brief_source').set({name:'Synthetic school source',scope:'school',schoolIds:['bjtu'],aiProcessing:'allow'});
  await t.test('only newly fetched changed article bodies invoke the enqueue hook; opening cached history does not',async()=>{
   const row=await put('brief_hook'),objects=new Map<string,Uint8Array>();let calls=0,body=text;
   const archive=materialArchive(pool,{put:async(key,value)=>{objects.set(key,value);},get:async key=>objects.get(key)||null,remove:async key=>{objects.delete(key);}},'hook',{now:()=>clock,onArticleSaved:async(value,school,article)=>{calls++;assert.equal(value.title,'保留的原标题');assert.equal(school,'bjtu');assert.equal(article,body);}}),source={id:'bjtu',name:'Synthetic',homepage:'https://example.test/',announcementUrl:'https://example.test/notices'};
   const reader=async(url:string)=>({url,html:'<article><p>'+body.replace(/\n/g,'</p><p>')+'</p></article>'});
   await archive.collect(row,source,reader);assert.equal(calls,1);await archive.collect(row,source,reader);await archive.collect(row,source,reader,{force:true});assert.equal(calls,1);body+='\n请注意补交条件已经更新。';await archive.collect(row,source,reader,{force:true});assert.equal(calls,2);
  });
  await t.test('opening reads cache only; concurrent collection and workers generate once',async()=>{
   const row=await put('brief_once');let calls=0,release!:(v:any)=>void;const jobs=noticeBriefJobs(pool,{scope:'once',now:()=>clock,enabled:()=>true,model,complete:async()=>{calls++;return new Promise(resolve=>{release=resolve;});}});
   assert.equal((await jobs.get(row,'bjtu')).state,'unavailable');assert.equal(calls,0);const enqueued=await Promise.all([jobs.enqueue(row,'bjtu',text),jobs.enqueue(row,'bjtu',text)]);assert.equal(enqueued.filter(Boolean).length,1);assert.equal((await jobs.get(row,'bjtu')).state,'pending');
   const first=jobs.run();for(let i=0;i<100&&!release;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(release);assert.equal((await jobs.run()).processed,0);release({text:output(),usage:{inputTokens:50,outputTokens:30,totalTokens:80}});await first;
   assert.equal(calls,1);assert.equal((await jobs.get(row,'bjtu')).state,'ready');assert.equal(await jobs.enqueue(row,'bjtu',text),false);assert.equal((await jobs.run()).processed,0);
   const budget=(await pool.query("SELECT * FROM campus_notice_brief_budget WHERE store_scope='once'")).rows[0];assert.equal(Number(budget.used_tokens),80);assert.equal(Number(budget.held_tokens),0);assert.equal((await pool.query("SELECT count(*) AS n FROM campus_documents WHERE collection='web_ai_accounts'")).rows[0].n,'0');
   assert.equal((await pool.query("SELECT input FROM campus_notice_briefs WHERE store_scope='once'")).rows[0].input.body,undefined);
   assert.match((await pool.query("SELECT request_id FROM campus_notice_briefs WHERE store_scope='once'")).rows[0].request_id,/^[a-f0-9-]{36}$/);
  });
  await t.test('canonical-only edits during generation and recollection keep one reusable task',async()=>{
   const row=await put('brief_canonical');let calls=0;
   const jobs=noticeBriefJobs(pool,{scope:'canonical',now:()=>clock,enabled:()=>true,model,complete:async()=>{calls++;await db.collection('items').doc(row._id).update({contentText:text.replace('申报','申\u200b报')});return{text:output()};}});
   await jobs.enqueue(row,'bjtu',text);await jobs.run();assert.equal((await jobs.get(row,'bjtu')).state,'ready');
   const canonicalEdit='  '+text.replace('申报','申\ufeff报').replace('\n','  \n\n  ')+'  ';
   await db.collection('items').doc(row._id).update({contentText:canonicalEdit+'\n\n## 附件：材料\n附件文本不进入摘要。'});
   assert.equal((await jobs.get(row,'bjtu')).state,'ready');assert.equal(await jobs.enqueue({...row,contentText:canonicalEdit},'bjtu',canonicalEdit),false);assert.equal((await jobs.run()).processed,0);assert.equal(calls,1);
   const changed=canonicalEdit+'\n申请要求已经更新。';await db.collection('items').doc(row._id).update({contentText:changed});assert.equal((await jobs.get(row,'bjtu')).state,'stale');assert.equal(await jobs.enqueue({...row,contentText:changed},'bjtu',changed),true);
  });
  await t.test('expired pending jobs neither wake nor continue a worker',async()=>{
   let dispatches=0,calls=0;const jobs=noticeBriefJobs(pool,{scope:'expired-pending',now:()=>clock,enabled:()=>true,model,dispatch:async()=>{dispatches++;},complete:async()=>{calls++;return{text:output()};}});
   await jobs.enqueue(await put('brief_expired_pending'),'bjtu',text);dispatches=0;
   await pool.query("UPDATE campus_notice_briefs SET expires_at=$1 WHERE store_scope='expired-pending'",[new Date(clock-1000).toISOString()]);await pool.query("UPDATE campus_notice_brief_workers SET dispatch_after='1970-01-01' WHERE store_scope='expired-pending'");
   await jobs.wake();const result=await jobs.run();assert.deepEqual({more:result.more,dispatches,calls},{more:false,dispatches:0,calls:0});
   await pool.query("INSERT INTO campus_notice_briefs(id,store_scope,item_id,school_id,source_id,signature,content_hash,raw_hash,raw_length,input,state,available_at,created_at,expires_at) SELECT b.id||'-'||n,b.store_scope,b.item_id,b.school_id,b.source_id,b.signature,b.content_hash,b.raw_hash,b.raw_length,b.input,b.state,b.available_at,b.created_at,b.expires_at FROM campus_notice_briefs b CROSS JOIN generate_series(1,200) n WHERE b.store_scope='expired-pending'");
   assert.equal(await jobs.enqueue(await put('brief_after_expired'),'bjtu',text),true,'Expired entries must not fill the live queue');
  });
  await t.test('daily call/token limits defer queued jobs, without resetting personal AI accounts',async()=>{
   let calls=0;const jobs=noticeBriefJobs(pool,{scope:'budget',now:()=>clock,enabled:()=>true,model,dailyCalls:1,dailyTokens:100000,complete:async()=>{calls++;return{text:output()};}});
   for(const id of ['brief_budget_a','brief_budget_b'])await jobs.enqueue(await put(id),'bjtu',text);await jobs.run();assert.equal(calls,1);const budget=(await pool.query("SELECT * FROM campus_notice_brief_budget WHERE store_scope='budget'")).rows[0];assert.ok(Number(budget.used_tokens)>1500);assert.equal(Number(budget.held_tokens),0);await jobs.run();assert.equal(calls,1);clock+=86400000;await jobs.run();assert.equal(calls,2);
  });
  await t.test('private/import-only/disabled sources and short/contaminated bodies are not sent',async()=>{
   let calls=0;const jobs=noticeBriefJobs(pool,{scope:'policy',now:()=>clock,enabled:()=>true,model,complete:async()=>{calls++;return{text:output()};}}),row=await put('brief_private');await db.collection('items').doc(row._id).update({ownerOpenid:'another-account',scope:'private'});assert.equal(await jobs.enqueue(row,'bjtu',text),false);assert.equal((await jobs.get(row,'bjtu')).state,'unavailable');
   const blocked=await put('brief_blocked');await db.collection('sources').doc('brief_source').update({allowAi:false});assert.equal(await jobs.enqueue(blocked,'bjtu',text),false);await db.collection('sources').doc('brief_source').update({allowAi:true});
   const contaminated=await put('brief_navigation','首页 硕士招生 博士招生 首页 内容 版权所有');assert.equal(await jobs.enqueue(contaminated,'bjtu',contaminated.contentText),false);assert.equal((await jobs.get(contaminated,'bjtu')).state,'unavailable');await jobs.run();assert.equal(calls,0);
  });
  await t.test('invalid output stores only a fixed diagnostic and never publishes or automatically resends it',async()=>{
   const row=await put('brief_invalid_diagnostic');let calls=0;const jobs=noticeBriefJobs(pool,{scope:'diagnostic',now:()=>clock,enabled:()=>true,model,complete:async()=>{calls++;return{text:'invalid provider output that must not be retained',usage:{inputTokens:10,outputTokens:10,totalTokens:20}};}});
   await jobs.enqueue(row,'bjtu',text);await jobs.run();await jobs.run();assert.equal(calls,1);
   const saved=(await pool.query("SELECT state,error_code,input,result FROM campus_notice_briefs WHERE store_scope='diagnostic'")).rows[0];assert.deepEqual(saved,{state:'failed',error_code:'BRIEF_EVIDENCE_JSON',input:{},result:null});
   const visible=await jobs.get(row,'bjtu');assert.equal(visible.state,'failed');assert.equal('content' in visible,false);assert.equal(JSON.stringify(visible).includes('provider output'),false);
  });
  await t.test('changes during generation discard old results, while new content gets a new task',async()=>{
   const row=await put('brief_changing');let calls=0;const jobs=noticeBriefJobs(pool,{scope:'changes',now:()=>clock,enabled:()=>true,model,complete:async()=>{calls++;await db.collection('items').doc(row._id).update({contentText:text+'\n正文已经修改。'});return{text:output(),usage:{inputTokens:20,outputTokens:20,totalTokens:40}};}});await jobs.enqueue(row,'bjtu',text);await jobs.run();assert.equal((await jobs.get(row,'bjtu')).state,'stale');assert.equal(calls,1);
   const changed=(await pool.query("SELECT body FROM campus_documents WHERE collection='items' AND id=$1",[row._id])).rows[0].body;assert.equal(await jobs.enqueue({...changed,_id:row._id},'bjtu',changed.contentText),true);
  });
  await t.test('revocation before dispatch and during generation cannot publish cached data',async()=>{
   const row=await put('brief_revoke');let calls=0;const jobs=noticeBriefJobs(pool,{scope:'revoke',now:()=>clock,enabled:()=>true,model,complete:async()=>{calls++;await db.collection('sources').doc('brief_source').update({enabled:false});return{text:output()};}});await jobs.enqueue(row,'bjtu',text);await jobs.run();assert.equal((await jobs.get(row,'bjtu')).state,'unavailable');assert.equal((await pool.query("SELECT result FROM campus_notice_briefs WHERE store_scope='revoke'")).rows[0].result,null);assert.equal(calls,1);await db.collection('sources').doc('brief_source').update({enabled:true});
  });
  await t.test('unknown calls retain conservative charge and never auto-resend; stale leases are reconciled',async()=>{
   const row=await put('brief_unknown');let calls=0;const jobs=noticeBriefJobs(pool,{scope:'unknown',now:()=>clock,enabled:()=>true,model,complete:async()=>{calls++;throw Object.assign(Error('Synthetic provider interruption'),{code:'MODEL_UNCERTAIN'});}});await jobs.enqueue(row,'bjtu',text);await jobs.run();await jobs.run();assert.equal(calls,1);assert.equal((await jobs.get(row,'bjtu')).state,'failed');const q=(await pool.query("SELECT * FROM campus_notice_brief_budget WHERE store_scope='unknown'")).rows[0];assert.ok(Number(q.used_tokens)>0);assert.equal(Number(q.held_tokens),0);
   await pool.query("UPDATE campus_notice_briefs SET state='running',quota_settled=false,lease_until=$1 WHERE store_scope='unknown'",[new Date(clock-1000).toISOString()]);await pool.query("UPDATE campus_notice_brief_budget SET used_tokens=0,held_tokens=$1 WHERE store_scope='unknown'",[Number(q.used_tokens)]);await cleanupNoticeBriefs(pool,clock);await jobs.run();assert.equal(calls,1);assert.equal((await pool.query("SELECT state FROM campus_notice_briefs WHERE store_scope='unknown'")).rows[0].state,'uncertain');
  });
 }finally{await native.end();await server.stop();}
});
