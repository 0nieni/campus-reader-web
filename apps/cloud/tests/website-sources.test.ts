import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import type {SqlPool} from '../src/postgres-storage';
import {postgresStorage} from '../src/postgres-storage';
import {postgresRepository} from '../src/postgres-repository';
import {websiteSources} from '../src/website-sources';
import {sourceInput,websiteUrl,parseWebsite,robotsAllowed,parserSource} from '../src/website-parser';
import {approvedSchoolUrl} from '../src/school-pages';
import {createGateway,toNotice} from '../src/gateway';
import {aiService} from '../src/ai-service';
import {readingPackage} from '../src/reading-package';
import type {WebsiteSourceInput} from '@campus/contracts';
const config:WebsiteSourceInput={name:'我的学院公告',entryUrl:'https://notice.example.edu.cn/list.htm',type:'html_list',categories:['college'],selectors:{},intervalMinutes:60,allowAi:true,authorized:true};
process.env.AI_CHAT_BASE_URL='https://api.deepseek.com';
process.env.AI_CHAT_API_KEY='test-key-never-real';
process.env.AI_CHAT_MODEL='fixture-model';
process.env.AI_EXECUTION_MODE='direct';
test('website input validation, exact-host URLs, robots and four parser types do not execute page instructions',()=>{
 for(const url of ['http://localhost/a','http://127.0.0.1/a','http://2130706433/a','http://[::1]/a','https://user:pass@example.edu.cn/a','https://example.edu.cn:8443/a','https://notice.example.edu.cn/a?token=private','file:///a'])assert.throws(()=>websiteUrl(url));
 assert.throws(()=>sourceInput({...config,ownerOpenid:'another'}));assert.throws(()=>sourceInput({...config,authorized:false}));assert.throws(()=>sourceInput({...config,categories:['mail']}));
 assert.equal(robotsAllowed('User-agent: *\nDisallow: /private\nAllow: /private/open','https://notice.example.edu.cn/private/a'),false);
 assert.equal(robotsAllowed('User-agent: *\nDisallow: /private\nAllow: /private/open','https://notice.example.edu.cn/private/open/a'),true);
 assert.equal(robotsAllowed('User-agent: CampusReader\nDisallow: /\nUser-agent: *\nAllow: /','https://notice.example.edu.cn/a'),false);
 assert.throws(()=>approvedSchoolUrl('https://other.example.edu.cn/a',parserSource(config,'source')));
 const xml='<rss><channel><item><title>公开竞赛报名通知</title><link>https://notice.example.edu.cn/info/1/12345.htm</link><pubDate>Sun, 18 Oct 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>请于10月25日前提交报名申请，详细要求和参赛对象请查看学院公开通知。<script>bad()</script></p>]]></description></item></channel></rss>';
 const rss=parseWebsite({url:config.entryUrl,html:xml},{...config,type:'rss'},'id');assert.equal(rss.length,1);assert.equal(rss[0]!.publishedAt,'2026-10-18T10:00:00.000Z');assert.ok(!rss[0]!.contentText!.includes('bad()'));
 const json=parseWebsite({url:config.entryUrl,html:JSON.stringify({data:{list:[{title:'我的活动安排公告',url:'/info/1/12345.htm',publishedAt:'2026-10-18',content:'这是一份测试公开活动公告，请同学们核实活动对象、时间安排以及报名材料要求。'}]}})},{...config,type:'json_api'},'id');assert.equal(json.length,1);
 const detail=parseWebsite({url:config.entryUrl,html:'<h1>学院活动报名通知</h1><article>本次学院活动面向在校学生，请在规定日期提交报名材料，详细要求见活动公告原文。</article>'},{...config,type:'html_detail'},'id');assert.equal(detail.length,1);assert.ok(detail[0]!.contentText);
 const custom=parseWebsite({url:config.entryUrl,html:'<li class="entry"><a href="/notice?id=42">学院的报名活动公告</a><time>2026-10-18</time></li>'},{...config,selectors:{listItem:'.entry',detailLink:'a',publishedAt:'time'}},'id');assert.equal(custom.length,1);
});
test('personal website lifecycle, isolation, concurrency, free-summary shutdown and AI charging use real SQL',async t=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),pool=getDatabase({connectionString}).pool;(pool as any).options.max=1;
 const sql=pool as unknown as SqlPool,repo=postgresRepository(sql);let time=Date.parse('2026-10-18T04:00:00Z'),reads=0,waitForList:(()=>Promise<void>)|null=null;
 const reader=async(url:string)=>{reads++;time+=100;if(url===config.entryUrl&&waitForList)await waitForList();return{url,html:url.endsWith('/robots.txt')?'User-agent: *\nDisallow: /private':url.includes('blocked')?'':url===config.entryUrl?'<ul><li><time>2026-10-18</time><a href="/info/1/12345.htm">学院竞赛报名通知</a></li><li><time>2020-10-18</time><a href="/info/1/12346.htm">过期公告不应导入</a></li></ul>':'<article>请于10月25日前提交竞赛报名材料，参赛对象为本校在读本科生，详细要求请以公告原文为准。</article>'};};
 const websites=websiteSources(sql,repo,reader,()=>time,async ms=>{time+=ms;});repo.material=websites.material;
 const owner={uid:'owner-uid',dataOwnerId:'owner',legacyLinked:false},member={uid:'member-uid',dataOwnerId:'member',legacyLinked:false};
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
  await repo.selectSchool(owner.dataOwnerId,'bjtu');await repo.selectSchool(member.dataOwnerId,'bjtu');
  const a=await websites.handle('sources.save',{schoolId:'bjtu',source:config},owner) as any,b=await websites.handle('sources.save',{schoolId:'bjtu',source:config},member) as any;assert.notEqual(a.id,b.id);
  await t.test('test/collect are explicit, stable, scoped and generate no summaries or AI tasks',async()=>{
   assert.equal(reads,0);const preview=await websites.handle('sources.test',{schoolId:'bjtu',sourceId:a.id},owner) as any;assert.equal(preview.count,2);
   assert.equal((await sql.query("SELECT id FROM campus_documents WHERE collection='items' AND id LIKE 'webnotice_%'")).rows.length,0);
   time+=1600;const result=await websites.handle('sources.refresh',{schoolId:'bjtu',sourceId:a.id},owner) as any;assert.equal(result.count,1);
   const rows=await sql.query("SELECT id,body FROM campus_documents WHERE collection='items' AND body->>'sourceId'=$1",[a.id]);assert.equal(rows.rows.length,1);const row=rows.rows[0]!.body;assert.equal(row.summary,undefined);assert.equal(row.autoSummary,undefined);
   assert.equal((await sql.query("SELECT id FROM campus_documents WHERE collection IN ('web_ai_tasks','web_ai_accounts')")).rows.length,0);
   const count=reads;await assert.rejects(websites.handle('sources.refresh',{schoolId:'bjtu',sourceId:a.id},owner),{code:'SOURCE_INTERVAL'});assert.equal(reads,count);
   await assert.rejects(websites.handle('sources.test',{schoolId:'bjtu',sourceId:a.id},member),{code:'NOT_FOUND'});
   const feed=await repo.items(await repo.scope('bjtu','owner'),0,1000,'2025-10-18');assert.ok(feed.some(row=>row.sourceId===a.id));
   assert.ok(!(await repo.items(await repo.scope('bjtu','member'),0,1000,'2025-10-18')).some(row=>row.sourceId===a.id));
   assert.ok(!(await repo.items(await repo.scope('school_001','owner'),0,1000,'2025-10-18')).some(row=>row.sourceId===a.id));
   assert.equal(toNotice({...row,_id:rows.rows[0]!.id,summary:{oneLine:'旧免费摘要'},autoSummary:{text:'旧自动摘要',basis:'body',version:'extractive-v1'}}).summary,null);
   const gateway=createGateway(repo,{ownerUid:owner.uid,dataOwnerId:owner.dataOwnerId});const old=await gateway({action:'school.summarize',input:{schoolId:'bjtu'}},{uid:owner.uid,isAnonymous:false});assert.equal(old.ok,false);
  });
  await t.test('imported material requires the normal private AI policy and charges one of three only after completing a reading',async()=>{
   const row=(await sql.query("SELECT id FROM campus_documents WHERE collection='items' AND body->>'sourceId'=$1",[a.id])).rows[0]!;
   const db=postgresStorage(sql);const pack=await readingPackage(db,repo,'owner','bjtu',[row.id]);assert.equal(pack.docs.length,1);
   let modelCalls=0;const ai=aiService(db,repo,async()=>{modelCalls++;return '报名截止10月25日。[R1](https://notice.example.edu.cn/info/1/12345.htm)';},()=>time);
   const q=(await ai.handle('ai.status',{},owner) as any).quota;assert.equal(q.limit,3);assert.equal(q.used,0);
   let task=await ai.handle('ai.start',{schoolId:'bjtu',itemIds:[row.id],requestId:'website_import_reading_task',service:'official',task:'summary'},owner) as any;
   while(task.state==='ready')task=await ai.handle('ai.step',{taskId:task.id,step:task.step},owner);
   assert.equal(task.state,'complete');assert.ok(modelCalls>0);assert.equal((await ai.handle('ai.status',{},owner) as any).quota.used,1);assert.equal((await ai.handle('ai.status',{},member) as any).quota.used,0);
   await websites.handle('sources.save',{schoolId:'bjtu',sourceId:a.id,source:{...config,allowAi:false}},owner);
   await assert.rejects(readingPackage(db,repo,'owner','bjtu',[row.id]),{code:'AI_POLICY_BLOCKED'});
  });
  await t.test('disable/remove preserve account boundaries and cannot republish withdrawn children',async()=>{
   await websites.handle('sources.toggle',{schoolId:'bjtu',sourceId:a.id,enabled:false},owner);
   await assert.rejects(websites.handle('sources.refresh',{schoolId:'bjtu',sourceId:a.id},owner),{code:'SOURCE_DISABLED'});
   await websites.handle('sources.remove',{schoolId:'bjtu',sourceId:a.id},owner);
   assert.equal((await websites.handle('sources.list',{schoolId:'bjtu'},owner) as any).sources.length,0);
   assert.equal((await websites.handle('sources.list',{schoolId:'bjtu'},member) as any).sources.length,1);
   assert.equal((await sql.query("SELECT body FROM campus_documents WHERE collection='items' AND body->>'sourceId'=$1",[a.id])).rows[0]!.body.status,'withdrawn');
  });
  await t.test('an in-flight collect holds the source lease and removal during I/O cannot republish it',async()=>{
   time+=2000;let release!:()=>void,started!:()=>void;
   const waiting=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});waitForList=()=>{started();return waiting;};
   const pending=websites.handle('sources.refresh',{schoolId:'bjtu',sourceId:b.id},member);await entered;
   await assert.rejects(websites.handle('sources.refresh',{schoolId:'bjtu',sourceId:b.id},member),{code:'SOURCE_BUSY'});
   await websites.handle('sources.remove',{schoolId:'bjtu',sourceId:b.id},member);release();
   await assert.rejects(pending,{code:'STALE_SOURCE'});waitForList=null;
   assert.equal((await sql.query("SELECT id FROM campus_documents WHERE collection='items' AND body->>'sourceId'=$1",[b.id])).rows.length,0);
  });
  await t.test('robots denial and daily request caps stop before fetching forbidden content',async()=>{
   const added=await websites.handle('sources.save',{schoolId:'bjtu',source:{...config,entryUrl:'https://notice.example.edu.cn/private/list.htm'}},owner) as any;
   const count=reads;await assert.rejects(websites.handle('sources.refresh',{schoolId:'bjtu',sourceId:added.id},owner),{code:'SOURCE_ROBOTS_BLOCKED'});assert.equal(reads,count);
   time+=1600;const day=new Date(time+8*3600000).toISOString().slice(0,10);
   await sql.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='user_profiles' AND id=$1",['owner',JSON.stringify({websiteFetchDay:day,websiteFetchCount:60})]);
   await assert.rejects(websites.handle('sources.test',{schoolId:'bjtu',sourceId:added.id},owner),{code:'SOURCE_DAILY_LIMIT'});assert.equal(reads,count);
  });
 }finally{await pool.end();await server.stop();}
});
