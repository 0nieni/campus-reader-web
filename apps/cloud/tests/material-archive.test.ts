import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import {materialArchive,MATERIAL_YEAR,type MaterialObjects} from '../src/material-archive';
import {materialFile} from '../src/material-file';
import {materialJobs,jobSignature,validJob} from '../src/material-jobs';
import {postgresRepository} from '../src/postgres-repository';
import {websiteSources} from '../src/website-sources';
import {AppError} from '../src/errors';
import type {SqlPool} from '../src/postgres-storage';
import type {ItemRow} from '../src/repository';
const source={id:'school_001',name:'合成大学',homepage:'https://www.pku.edu.cn/',announcementUrl:'https://www.pku.edu.cn/notices.html'};
test('retained payloads use real local SQL: fixed expiry, revocation, account/school isolation, recovery and collection jobs',async t=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),pool=getDatabase({connectionString}).pool;
 (pool as any).options.max=1;const sql=pool as unknown as SqlPool,repo=postgresRepository(sql);
 let at=Date.now(),reads=0,downloads=0;
 const data=new Map<string,Uint8Array>(),objects:MaterialObjects={async put(key,bytes){data.set(key,bytes);},async get(key){return data.get(key)||null;},async remove(key){data.delete(key);}};
 let html='<article><p>合成公告测试正文，报名需要提交申请材料，请查看下列附件中的时间和要求，仅供自动化测试。申请人请仔细核对各项要求，提交后关注审核结果和补充材料通知。</p><a href="/a.pdf">扫描材料.pdf</a></article>';
 const reader=async(url:string)=>{reads++;return{url,html};};
 const archive=materialArchive(sql,objects,'fixture',{now:()=>at,download:async url=>{downloads++;return{url,bytes:new Uint8Array([37,80,68,70]),contentType:'application/pdf'};},extract:async()=>({state:'no_text',text:'',message:'扫描件，未提取到文字；原文件已保存。'})});
 const row:ItemRow={_id:'archive-fixture',sourceId:'archive-source',schoolIds:[source.id],scope:'school',status:'published',title:'合成公告',originalUrl:'https://www.pku.edu.cn/info/1/22.htm',publishedAt:new Date(at).toISOString()};
 const doc=async(collection:string,id:string,body:unknown)=>sql.query('INSERT INTO campus_documents(collection,id,body) VALUES($1,$2,$3::jsonb) ON CONFLICT(collection,id) DO UPDATE SET body=EXCLUDED.body',[collection,id,JSON.stringify(body)]);
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
  await doc('items',row._id,row);await doc('sources',row.sourceId!,{scope:'school',schoolIds:[source.id],enabled:true,aiProcessing:'allow'});
  let saved:ItemRow;
  await t.test('body snapshots and raw scans persist; repeat checks do not renew one-year expiry',async()=>{
   saved=await archive.collect(row,source,reader);assert.match(saved.contentText!,/合成公告/);assert.equal(saved.materialArchive!.files.length,2);assert.match(saved.materialArchive!.attachmentNote,/扫描件/);
   const expiry=saved.materialExpiresAt,firstKeys=[...data.keys()];at+=3600000;
   await archive.collect(row,source,reader);assert.equal(reads,1);assert.equal(downloads,1);
   const checked=await archive.collect(row,source,reader,{force:true});assert.equal(checked.materialExpiresAt,expiry);assert.deepEqual([...data.keys()],firstKeys);assert.equal(downloads,2);
  });
  await t.test('missing blobs repair without renewing TTL; uncertain finalization garbage cannot delete live data',async()=>{
   const file=(await sql.query("SELECT * FROM campus_material_files WHERE kind='article' AND store_scope='fixture'")).rows[0];data.delete(file.blob_key);
   const repaired=await archive.collect(row,source,reader);assert.equal(repaired.materialExpiresAt,saved!.materialExpiresAt);assert.equal(reads,3);
   const current=(await sql.query("SELECT * FROM campus_material_files WHERE kind='article' AND store_scope='fixture'")).rows[0];
   await sql.query('INSERT INTO campus_material_garbage(store_scope,blob_key) VALUES($1,$2) ON CONFLICT DO NOTHING',['fixture',current.blob_key]);
   await archive.cleanup();assert.ok(data.has(current.blob_key));
  });
  await t.test('private school/account/source checks gate reads; preview cannot read production objects',async()=>{
   const file=saved!.materialArchive!.files.find(file=>file.kind==='attachment')!;
   await assert.rejects(()=>archive.readFile(file.id,{...row,ownerOpenid:'other'},source));
   await assert.rejects(()=>archive.readFile(file.id,row,{...source,id:'bjtu'}));
   const preview=materialArchive(sql,objects,'other-deploy',{now:()=>at});await assert.rejects(()=>preview.readFile(file.id,row,source));
   await doc('sources',row.sourceId!,{schoolIds:[source.id],enabled:false});await assert.rejects(()=>archive.readFile(file.id,row,source));
   await doc('sources',row.sourceId!,{scope:'school',schoolIds:[source.id],enabled:true,aiProcessing:'allow'});
  });
  await t.test('downloads authorize the current school, stream attachments and suppress caching',async()=>{
   await repo.selectSchool('fixture-user',source.id);const file=saved!.materialArchive!.files.find(file=>file.kind==='attachment')!;
   const url=`https://example.test/.netlify/functions/material-file?schoolId=${source.id}&itemId=${row._id}&fileId=${file.id}`;
   const response=await materialFile(new Request(url),'fixture-user',repo,archive,async()=>source);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.arrayBuffer()).byteLength,4);assert.match(response.headers.get('content-disposition')!,/attachment/);
   await repo.selectSchool('fixture-user','bjtu');assert.equal((await materialFile(new Request(url),'fixture-user',repo,archive,async()=>source)).status,404);
  });
  await t.test('removed links stop contributing evidence and enter physical deletion queue',async()=>{
   html=html.replace(/<a\s[^>]+>.*?<\/a>/,'');const updated=await archive.collect(row,source,reader,{force:true});assert.equal(updated.materialArchive!.files.length,1);await archive.cleanup();assert.equal(data.size,1);
  });
  await t.test('expiry blocks files immediately; local SQL cleanup preserves announcement identity and unrelated reminder tables',async()=>{
   const files=(await sql.query("SELECT * FROM campus_material_files WHERE kind='article' AND store_scope='fixture'")).rows;
   at=new Date(files[0].expires_at).getTime();await assert.rejects(()=>archive.readFile(files[0].id,row,source));
   await sql.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='items' AND id=$1",[row._id,JSON.stringify({materialExpiresAt:new Date(Date.now()-1).toISOString()})]);assert.equal((await repo.item(row._id))!.contentText,undefined);
   const before=(await sql.query("SELECT count(*) FROM campus_reminder_accounts")).rows[0].count;
   await archive.cleanup();assert.equal(data.size,0);assert.equal((await repo.item(row._id))!._id,row._id);assert.equal((await sql.query("SELECT count(*) FROM campus_reminder_accounts")).rows[0].count,before);
  });
  await t.test('a bounded detail read leaves attachments pending and a later call resumes the saved snapshot',async()=>{
   at=Date.now();html='<article><p>合成的公告正文用于验证中断恢复，请在正式参与前核对项目条件、材料清单及各阶段的报名安排。</p><a href="/later.pdf">待采集.pdf</a></article>';
   const pendingRow={...row,_id:'pending-fixture',publishedAt:new Date(at).toISOString()};await doc('items',pendingRow._id,pendingRow);
   const partial=await archive.collect(pendingRow,source,reader,{deadline:at});assert.equal(partial.materialPending,true);assert.equal(partial.materialArchive!.files.length,1);
   const done=await archive.collect(pendingRow,source,reader);assert.equal(done.materialPending,false);assert.equal(done.materialArchive!.files.length,2);
  });
  await t.test('a real private stored attachment cannot be downloaded by another account or school',async()=>{
   const privateRow={...row,_id:'private-file-fixture',sourceId:'private-file-source',scope:'private',ownerOpenid:'file-owner',importKind:'website',publishedAt:new Date(at).toISOString()};
   await doc('sources',privateRow.sourceId,{ownerOpenid:'file-owner',scope:'private',schoolIds:[source.id],enabled:true});await doc('items',privateRow._id,privateRow);
   const savedPrivate=await archive.collect(privateRow,source,reader),file=savedPrivate.materialArchive!.files.find(file=>file.kind==='attachment')!;
   const url=`https://example.test/.netlify/functions/material-file?schoolId=${source.id}&itemId=${privateRow._id}&fileId=${file.id}`;
   await repo.selectSchool('file-owner',source.id);await repo.selectSchool('other-file-owner',source.id);
   assert.equal((await materialFile(new Request(url),'file-owner',repo,archive,async()=>source)).status,200);
   assert.equal((await materialFile(new Request(url),'other-file-owner',repo,archive,async()=>source)).status,404);
   await assert.rejects(()=>archive.readFile(file.id,privateRow,{...source,id:'school_002'}));
  });
  await t.test('inline JSON bodies remain usable with a fixed expiry when linked HTML is unavailable',async()=>{
   at=Date.now();const owner='inline-owner';await repo.selectSchool(owner,source.id);
   let body='这是一份合成的公开报名公告，请提交个人申请表和项目说明，具体要求以来源提供的这份正文为准。';
   const config={name:'合成 JSON 来源',entryUrl:'https://inline.example.edu.cn/data.json',type:'json_api',categories:['school'],selectors:{},intervalMinutes:15,allowAi:true,authorized:true};
   const websites=websiteSources(sql,repo,async url=>{if(url.endsWith('/robots.txt'))return{url,html:'User-agent: *\nAllow: /'};if(url===config.entryUrl)return{url,html:JSON.stringify({data:{list:[{title:'合成报名公告',url:'/notice.htm',content:body}]}})};throw new AppError('SOURCE_NOT_FOUND','原文链接不存在。');},()=>at,async ms=>{at+=ms;},archive);
   const identity={uid:'inline-uid',dataOwnerId:owner,legacyLinked:false};const savedSource=await websites.handle('sources.save',{schoolId:source.id,source:config},identity) as {id:string};
   await websites.handle('sources.refresh',{schoolId:source.id,sourceId:savedSource.id},identity);
   let entry=(await sql.query("SELECT id,body FROM campus_documents WHERE collection='items' AND body->>'sourceId'=$1",[savedSource.id])).rows[0];const expiry=entry.body.materialExpiresAt;
   assert.equal((await websites.archivedMaterial({...entry.body,_id:entry.id})).contentText,body);
   at+=86400000;await websites.handle('sources.refresh',{schoolId:source.id,sourceId:savedSource.id},identity);
   entry=(await sql.query("SELECT id,body FROM campus_documents WHERE collection='items' AND id=$1",[entry.id])).rows[0];assert.equal(entry.body.materialExpiresAt,expiry);
   assert.equal((await websites.archivedMaterial({...entry.body,_id:entry.id},{force:true})).contentText,body);
   body+='新增一项材料要求。';at+=86400000;await websites.handle('sources.refresh',{schoolId:source.id,sourceId:savedSource.id},identity);
   assert.notEqual((await repo.item(entry.id))!.materialExpiresAt,expiry);
   await websites.handle('sources.toggle',{schoolId:source.id,sourceId:savedSource.id,enabled:false},identity);await assert.rejects(()=>websites.archivedMaterial({...entry.body,_id:entry.id}));
  });
  await t.test('daily queue deduplicates, selects recent schools/enabled personal sources and safely resumes expired leases',async()=>{
   at=Date.now();let schools=0,sources=0,materials=0;const materialIds:string[]=[];
   await doc('school_sync',source.id,{lastVisitedAt:new Date(at-29*86400000).toISOString()});await doc('school_sync','school_002',{lastVisitedAt:new Date(at-31*86400000).toISOString()});await doc('school_sync','school_003',{lastVisitedAt:new Date(at-5*86400000).toISOString()});
   await doc('sources','personal-fixture',{ownerOpenid:'fixture-owner',importKind:'website',schoolIds:['school_002'],enabled:true});
   await doc('sources','disabled-fixture',{ownerOpenid:'fixture-owner',importKind:'website',schoolIds:['bjtu'],enabled:false});
   const jobs=materialJobs(sql,{async school(){schools++;},async source(){sources++;},async material(row){materials++;materialIds.push(row._id);},async cleanup(){return{expired:0,deleted:0};}},()=>at);
   await jobs.start();await jobs.start();assert.equal(Number((await sql.query('SELECT count(*) FROM campus_collection_jobs')).rows[0].count),3);
   await sql.query("UPDATE campus_collection_jobs SET state='running',lease_id='crashed',lease_until=$1,attempts=1 WHERE kind='school'",[new Date(at-1).toISOString()]);
   const result=await jobs.run(at+120000);assert.equal(result.more,false);assert.equal(schools,2);assert.equal(sources,1);assert.ok(materials>=1);assert.equal(new Set(materialIds).size,materialIds.length); // Global sources are collected once across active schools.
   await jobs.start();await jobs.run(at+120000);assert.equal(schools,2);assert.equal(sources,1);
  });
 }finally{await pool.end();await server.stop();}
});
test('background signatures reject replay windows, modified bodies and absent configuration',()=>{
 const secret='synthetic-test-secret-at-least-32-characters',at=String(Date.now()),sig=jobSignature(secret,at,'{}');assert.ok(validJob(secret,at,'{}',sig));assert.equal(validJob(secret,at,'{"x":1}',sig),false);assert.equal(validJob(secret,at,'{}',sig,Number(at)+300001),false);assert.equal(validJob(undefined,at,'{}',sig),false);
});
