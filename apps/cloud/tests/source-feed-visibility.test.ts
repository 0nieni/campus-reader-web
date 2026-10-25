import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import {postgresRepository} from '../src/postgres-repository';
import {postgresStorage,type SqlPool} from '../src/postgres-storage';
import {createGateway} from '../src/gateway';
import {schoolDirectory} from '../src/school-directory';
import {websiteSources} from '../src/website-sources';
import {readingPackage} from '../src/reading-package';
import {bookmarksService} from '../src/bookmarks';

test('per-account source display preferences filter home pages before pagination without revoking reading access',async t=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),pool=getDatabase({connectionString}).pool;
 (pool as any).options.max=1;const sql=pool as unknown as SqlPool,repo=postgresRepository(sql),db=postgresStorage(sql);
 let reads=0;const reader=async():Promise<never>=>{reads++;throw new Error('display preferences must not fetch');};
 const directory=schoolDirectory(sql,repo,reader),websites=websiteSources(sql,repo,reader);
 const caller={uid:'alice-uid',isAnonymous:false},identity={uid:'alice-uid',dataOwnerId:'alice',legacyLinked:false};
 const features={directory:{refresh:directory.refresh,sources:directory.sources,request:async()=>({})},websites,bookmarks:bookmarksService(db,repo)};
 const gateway=createGateway(repo,{ownerUid:'alice-uid',dataOwnerId:'alice'},Date.now,features);
 const action=(action:string,input:any)=>gateway({action,input},caller);
 const toggle=(sourceId:string,visible:boolean,schoolId='school_002')=>action('sources.feedVisibility',{schoolId,sourceId,visible});
 const feed=async(cursor?:string)=>{const result=await action('feed.list',{schoolId:'school_002',keyword:'显示筛选测试公告',...(cursor?{cursor}:{})});assert.ok(result.ok);return result.data as any;};
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
  await repo.selectSchool('alice','school_002');await repo.selectSchool('bob','school_002');
  const insert=async(collection:string,id:string,body:any)=>sql.query('INSERT INTO campus_documents(collection,id,body) VALUES($1,$2,$3::jsonb)',[collection,id,JSON.stringify({_id:id,...body})]);
  for(const source of ['directory_school_002__statistics','directory_school_002__psychology'])await insert('sources',source,{name:'测试公开通知',scope:'school',schoolIds:['school_002'],aiProcessing:'allow'});
  for(let i=0;i<50;i++)await insert('items','visibility-'+String(i).padStart(2,'0'),{title:'显示筛选测试公告 '+i,sourceId:i<25?'directory_school_002__statistics':'directory_school_002__psychology',sourceName:'测试公开来源',scope:'school',schoolIds:['school_002'],status:'published',categories:['school'],publishedAt:new Date(Date.now()-i*1000).toISOString(),originalUrl:'https://example.edu.cn/notice/'+i,contentText:'本地测试公告正文，请按照公告要求准备材料并在规定时间内报名。',aiProcessing:'allow'});
  await t.test('defaults visible and persists hidden state without changing global source or school',async()=>{
   const initial=await action('school.sources',{schoolId:'school_002'});assert.ok(initial.ok);assert.equal((initial.data as any).sources[0].showInFeed,true);
   const sourceBefore=await sql.query("SELECT body FROM campus_documents WHERE collection='sources' AND id='directory_school_002__statistics'");
   const saved=await toggle('directory_school_002__statistics',false);assert.ok(saved.ok);assert.equal((saved.data as any).visible,false);
   const reloaded=await action('school.sources',{schoolId:'school_002'});assert.ok(reloaded.ok);assert.equal((reloaded.data as any).sources[0].showInFeed,false);
   assert.deepEqual((await sql.query("SELECT body FROM campus_documents WHERE collection='sources' AND id='directory_school_002__statistics'")).rows,sourceBefore.rows);
   assert.equal(await repo.selectedSchool('alice'),'school_002');assert.equal(reads,0);
  });
  await t.test('pagination contains only visible sources and hiding does not affect another account or internal AI candidates',async()=>{
   const page=await feed();assert.equal(page.items.length,20);assert.equal(page.nextCursor,'20');assert.ok(page.items.every((item:any)=>Number(item.id.split('-')[1])>=25));
   const next=await feed('20');assert.equal(next.items.length,5);assert.equal(next.nextCursor,null);
   const bob=createGateway(repo,{ownerUid:'bob-uid',dataOwnerId:'bob'},Date.now,features);
   const other=await bob({action:'feed.list',input:{schoolId:'school_002'}},{uid:'bob-uid',isAnonymous:false});assert.ok(other.ok);assert.ok((other.data as any).items.some((item:any)=>item.id==='visibility-00'));
   const candidate=await repo.items(await repo.scope('school_002','alice'),0,100,new Date(Date.now()-86400000).toISOString());assert.equal(candidate.length,50);
   const detail=await action('feed.detail',{schoolId:'school_002',itemId:'visibility-00'});assert.ok(detail.ok);
   assert.equal((await readingPackage(db,repo,'alice','school_002',['visibility-00'])).docs.length,1);
   assert.ok((await action('favorites.set',{schoolId:'school_002',itemId:'visibility-00',saved:true})).ok);
   assert.ok((await action('favorites.list',{})).ok);
  });
  await t.test('private source display is independent of enabled state, survives editing and does not leak to another owner',async()=>{
   const source={name:'测试个人来源',entryUrl:'https://mine.example.edu.cn/list',type:'html_list',categories:['school'],intervalMinutes:60,selectors:{},allowAi:true,authorized:true};
   const added=await websites.handle('sources.save',{schoolId:'school_002',source},identity) as any;
   assert.ok((await toggle(added.id,false)).ok);
   await insert('items','private-visibility',{title:'个人来源显示测试',sourceId:added.id,sourceName:source.name,scope:'private',ownerOpenid:'alice',schoolIds:['school_002'],importKind:'website',status:'published',categories:['school'],publishedAt:new Date().toISOString(),contentText:'本人导入的本地测试正文。'});
   const privateHidden=await action('feed.list',{schoolId:'school_002',keyword:'个人来源显示测试'});assert.ok(privateHidden.ok);assert.deepEqual((privateHidden.data as any).items,[]);
   assert.ok((await action('feed.detail',{schoolId:'school_002',itemId:'private-visibility'})).ok);
   await websites.handle('sources.save',{schoolId:'school_002',sourceId:added.id,source:{...source,name:'改名后来源'}},identity);
   const list=await websites.handle('sources.list',{schoolId:'school_002'},identity) as any;assert.equal(list.sources[0].showInFeed,false);assert.equal(list.sources[0].enabled,true);
   await websites.handle('sources.toggle',{schoolId:'school_002',sourceId:added.id,enabled:false},identity);
   assert.ok((await toggle(added.id,true)).ok);const paused=await websites.handle('sources.list',{schoolId:'school_002'},identity) as any;assert.equal(paused.sources[0].enabled,false);assert.equal(paused.sources[0].showInFeed,true);
   const bob=createGateway(repo,{ownerUid:'bob-uid',dataOwnerId:'bob'},Date.now,features);
   assert.equal((await bob({action:'sources.feedVisibility',input:{schoolId:'school_002',sourceId:added.id,visible:false}},{uid:'bob-uid',isAnonymous:false})).ok,false);
   assert.equal((await toggle(added.id,false,'school_001')).ok,false);
  });
  await t.test('supports preferences for a browsed school, restores a source and rejects invalid or forged mutations',async()=>{
   assert.ok((await toggle('directory_school_001__teaching',false,'school_001')).ok);assert.equal(await repo.selectedSchool('alice'),'school_002');
   assert.ok((await toggle('directory_school_002__statistics',true)).ok);assert.ok((await feed()).items.some((item:any)=>item.id==='visibility-00'));
   for(const input of [{schoolId:'school_002',sourceId:'directory_school_002__statistics',visible:'false'},{schoolId:'school_002',sourceId:'missing',visible:false},{schoolId:'school_002',sourceId:'directory_school_002__statistics',visible:false,ownerId:'bob'}])assert.equal((await action('sources.feedVisibility',input)).ok,false);
   assert.equal((await gateway({action:'sources.feedVisibility',input:{schoolId:'school_002',sourceId:'directory_school_002__statistics',visible:false}},{uid:'alice-uid',isAnonymous:true})).ok,false);
   assert.equal(reads,0);assert.equal((await sql.query("SELECT id FROM campus_documents WHERE collection IN ('web_ai_accounts','web_ai_tasks')")).rows.length,0);
  });
  await t.test('concurrent per-school changes preserve selection and unrelated profile data without duplicate hidden IDs',async()=>{
   await sql.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='user_profiles' AND id=$1",['alice',JSON.stringify({testKeep:{memory:'keep',bookmarks:['keep']}})]);
   await Promise.all([toggle('directory_school_002__statistics',false),toggle('directory_school_002__psychology',false),toggle('directory_school_001__teaching',false,'school_001')]);
   await toggle('directory_school_002__statistics',false);
   const profile=(await sql.query("SELECT body FROM campus_documents WHERE collection='user_profiles' AND id='alice'")).rows[0]!.body;
   assert.deepEqual(profile.hiddenFeedSources.school_002.sort(),['directory_school_002__psychology','directory_school_002__statistics']);
   assert.deepEqual(profile.hiddenFeedSources.school_001,['directory_school_001__teaching']);assert.equal(profile.selectedSchoolId,'school_002');assert.deepEqual(profile.testKeep,{memory:'keep',bookmarks:['keep']});
  });
  await t.test('bulk settings cover this school only and source inspection filters before pagination without changing hidden preferences',async()=>{
   const initial=await action('sources.displayState',{schoolId:'school_002'});assert.ok(initial.ok);assert.equal((initial.data as any).total,3);
   const hidden=await action('sources.feedVisibilityAll',{schoolId:'school_002',visible:false});assert.ok(hidden.ok);assert.deepEqual(hidden.data,{total:3,shown:0,hidden:3});
   const empty=await feed();assert.equal(empty.items.length,0);assert.equal(empty.hiddenSourceCount,3);
   const inspected=await action('feed.list',{schoolId:'school_002',sourceId:'directory_school_002__statistics',keyword:'显示筛选测试公告'});assert.ok(inspected.ok);assert.equal((inspected.data as any).items.length,20);assert.equal((inspected.data as any).nextCursor,'20');assert.ok((inspected.data as any).items.every((item:any)=>Number(item.id.split('-')[1])<25));
   const stillHidden=await action('sources.displayState',{schoolId:'school_002'});assert.ok(stillHidden.ok);assert.equal((stillHidden.data as any).hidden,3);
   const restored=await action('sources.feedVisibilityAll',{schoolId:'school_002',visible:true});assert.ok(restored.ok);assert.deepEqual(restored.data,{total:3,shown:3,hidden:0});
   const profile=(await sql.query("SELECT body FROM campus_documents WHERE collection='user_profiles' AND id='alice'")).rows[0]!.body;assert.deepEqual(profile.hiddenFeedSources.school_001,['directory_school_001__teaching']);
   for(const input of [{schoolId:'school_002',visible:'no'},{schoolId:'school_002',visible:false,ownerId:'bob'}])assert.equal((await action('sources.feedVisibilityAll',input)).ok,false);
   assert.equal((await action('feed.list',{schoolId:'school_002',sourceId:'bad/id'})).ok,false);
   assert.equal(reads,0);
  });
 }finally{await pool.end();await server.stop();}
});
