import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import type {SqlPool} from '../src/postgres-storage';
import {postgresRepository} from '../src/postgres-repository';
import {schoolDirectory} from '../src/school-directory';
import {publicSources} from '../src/public-sources';
import {createGateway} from '../src/gateway';
import {materialJobs} from '../src/material-jobs';
import {extractNotices} from '../src/school-pages';
import {schoolSources} from '../src/school-sources';

const csId='15ff78a66acb889d000bcdb945e4c113',legacyMain='15ff78a66ac1382a00034f3869d0aa1c';
test('navigation adds the exact innovation column while retaining all three existing school identities',()=>{
 const sources=schoolSources({id:'bjtu',name:'北京交通大学',status:'ready'});
 assert.equal(sources.sources.length,4);
 assert.deepEqual(sources.sources.slice(0,3).map(s=>s.key),['directory','bjtu-bksy','bjtu-cs-tzgg']);
 const added=sources.sources[3]!;assert.equal(added.announcementUrl,'https://bksy.bjtu.edu.cn/center/cc/638521937252901248.html');assert.match(sources.note,/2024.*历史/);
 const rows=extractNotices({url:added.announcementUrl,html:'<nav><a href="/info/1001/99000.htm">与栏目无关的其他通知</a></nav><div class="textright_news"><ul><li><a href="/center/cc/news/638561446312347078.html">关于举办2024年校内工程实践竞赛的通知</a></li></ul></div>'},added);
 assert.equal(rows.length,1);assert.equal(rows[0]!.publishedAt,null);assert.match(rows[0]!.title,/2024/);
});
test('the undergraduate column retains adjacent publication dates independently of title dates',()=>{
 const source=schoolSources({id:'bjtu',name:'北京交通大学',status:'ready'}).sources.find(row=>row.key==='bjtu-bksy')!;
 const rows=extractNotices({url:source.announcementUrl,html:'<span class="spTime">[2026/06/24]</span><div class="yuanxi2"><a href="/informations/639179144387037529.html">关于2026年7月10日报名截止的通知</a></div>'},source);
 assert.equal(rows[0]!.publishedAt,'2026-06-23T16:00:00.000Z');
});
test('legacy school cards collect on first selection, retain IDs and appear in the feed and daily school job',async()=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),pool=getDatabase({connectionString}).pool,sql=pool as unknown as SqlPool,repo=postgresRepository(sql);
 const reads:string[]=[],owner='school-owner';
 const directory=schoolDirectory(sql,repo,async(url)=>{reads.push(url);const id=url.includes('cs.bjtu')?'99001':url.includes('bksy.bjtu')?'99002':'99003';return{url,html:`<ul><li><time>${new Date().toISOString().slice(0,10)}</time><a href="/info/1001/${id}.htm">本地验收学校公开报名通知${id}</a></li></ul>`};});
 const service=publicSources(sql,repo,{publicPage:async()=>{throw new Error('not a public competition');},publicDownload:async()=>{throw new Error('no files');}},directory.sources);
 const gateway=createGateway(repo,{ownerUid:'school-user',dataOwnerId:owner},Date.now,{websites:{handle:service.handle},directory:{refresh:directory.refresh,sources:directory.sources,request:async()=>({})}});
 const action=(action:string,input:Record<string,unknown>)=>gateway({action,input},{uid:'school-user',isAnonymous:false});
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));await repo.selectSchool(owner,'bjtu');
  const before=await service.catalogue('bjtu',owner),card=before.sources.find(row=>row.id===csId)!;
  assert.ok(card);assert.equal(card.collectable,true);assert.equal(card.checkedAt,null);assert.equal(reads.length,0);
  await repo.setAllSourceFeedVisibility!(owner,'bjtu',false);
  const selected=await action('sources.feedVisibility',{schoolId:'bjtu',sourceId:csId,visible:true});assert.ok(selected.ok);assert.equal((selected.data as any).initialCollection.state,'ready');
  assert.equal(reads.filter(url=>url.includes('cs.bjtu')).length,1);
  const collected=await service.catalogue('bjtu',owner);assert.equal(collected.sources.find(row=>row.id===csId)!.state,'ready');
  const page=await action('feed.list',{schoolId:'bjtu',sourceId:csId});assert.ok(page.ok);assert.ok((page.data as any).items.some((row:any)=>row.title.includes('99001')));
  await action('sources.feedVisibility',{schoolId:'bjtu',sourceId:csId,visible:false});await action('sources.feedVisibility',{schoolId:'bjtu',sourceId:csId,visible:true});assert.equal(reads.filter(url=>url.includes('cs.bjtu')).length,1);
  // Explicit subscriptions keep updating even after the ordinary 30-day activity window.
  await sql.query("UPDATE campus_documents SET body=body || $1::jsonb WHERE collection='school_sync' AND id='bjtu'",[JSON.stringify({lastVisitedAt:new Date(Date.now()-31*86400000).toISOString()})]);
  const jobs=materialJobs(sql,{school:async()=>{},source:async()=>{},material:async()=>{},cleanup:async()=>({expired:0,deleted:0})});await jobs.start();
  assert.equal((await sql.query("SELECT id FROM campus_collection_jobs WHERE kind='school' AND school_id='bjtu'")).rows.length,1);
  await repo.setAllSourceFeedVisibility!(owner,'bjtu',false);await repo.setSourceFeedVisibility!(owner,'bjtu',legacyMain,true);
  const alias=await action('feed.list',{schoolId:'bjtu',sourceId:legacyMain});assert.ok(alias.ok);assert.ok((alias.data as any).items.some((row:any)=>row.title.includes('99003')));
  await repo.setSourceFeedVisibility!(owner,'bjtu',legacyMain,false);
  const hidden=await action('feed.list',{schoolId:'bjtu'});assert.ok(hidden.ok);assert.equal((hidden.data as any).items.length,0);
 }finally{await pool.end();await server.stop();}
});

test('a failed initial collection preserves the saved choice and never collects another school or unverified source',async()=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),pool=getDatabase({connectionString}).pool,sql=pool as unknown as SqlPool,repo=postgresRepository(sql);let refreshes=0;
 const directory=schoolDirectory(sql,repo,async()=>{throw new Error('no public page');});
 const gateway=createGateway(repo,{ownerUid:'test-user',dataOwnerId:'owner'},Date.now,{directory:{refresh:async()=>{refreshes++;throw new Error('upstream unavailable');},sources:directory.sources,request:async()=>({})}});
 const action=(sourceId:string,schoolId='bjtu')=>gateway({action:'sources.feedVisibility',input:{schoolId,sourceId,visible:true}},{uid:'test-user',isAnonymous:false});
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));await repo.selectSchool('owner','bjtu');
  const result=await action(csId);assert.ok(result.ok);assert.equal((result.data as any).visible,true);assert.equal((result.data as any).initialCollection.state,'unavailable');assert.equal(refreshes,1);
  assert.equal((await repo.feedSourceSelection!('owner','bjtu')).shownIds.includes(csId),true);
  await action('competition_001');assert.equal(refreshes,1);
  await action('directory_school_002__statistics','school_002');assert.equal(refreshes,1);
 }finally{await pool.end();await server.stop();}
});
