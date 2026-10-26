import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import type {SqlPool} from '../src/postgres-storage';
import {postgresRepository} from '../src/postgres-repository';
import {publicSources} from '../src/public-sources';
import {websiteSources} from '../src/website-sources';
import {schoolDirectory} from '../src/school-directory';
import {competitionDirectory} from '../src/competition-directory';
import {createGateway} from '../src/gateway';
import {materialArchive} from '../src/material-archive';
import {materialJobs} from '../src/material-jobs';
import {AppError} from '../src/errors';

const source=competitionDirectory.find(row=>row.number===10)!;
test('manual competition updates collect listed unverified sources without auto-subscribing or promoting daily collection',async()=>{
 const server=new NetlifyDB({logger(){}}),pool=getDatabase({connectionString:await server.start()}).pool,sql=pool as unknown as SqlPool,repo=postgresRepository(sql),objects=new Map<string,Uint8Array>();let at=Date.now(),reads=0;
 const archive=materialArchive(sql,{async put(key,bytes){objects.set(key,bytes);},async get(key){return objects.get(key)||null;},async remove(key){objects.delete(key);}},'manual-test',{now:()=>at});
 const readers={async publicPage(url:string){reads++;return{url,html:url===source.entryUrl?`<ul><li><time>${new Date(at).toISOString().slice(0,10)}</time><a href="/info/1001/99001.htm">本地手动采集竞赛报名通知</a></li></ul>`:'<article><p>这是本地合成竞赛通知的完整正文，包含报名方式、参赛材料和赛程说明，用于检验原有资料入库权限与保存期限。</p></article>'};},async publicDownload():Promise<never>{throw new Error('no files');}};
 const directory=schoolDirectory(sql,repo,async()=>{throw new Error('not a school update');});
 const service=publicSources(sql,repo,readers,directory.sources,archive,()=>at),gateway=createGateway(repo,{ownerUid:'user',dataOwnerId:'owner'},()=>at,{websites:service});
 const action=(action:string,input:Record<string,unknown>)=>gateway({action,input},{uid:'user',isAnonymous:false});
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));await repo.selectSchool('owner','bjtu');
  assert.equal((await service.catalogue('bjtu','owner')).sources.find(row=>row.id===source.id)!.showInFeed,false);assert.equal(reads,0);
  const updated=await action('sources.public.refresh',{schoolId:'bjtu',sourceId:source.id});assert.ok(updated.ok);assert.equal((updated.data as any).count,1);assert.equal(reads,1);
  const card=(await service.catalogue('bjtu','owner')).sources.find(row=>row.id===source.id)!;assert.equal(card.state,'ready');assert.equal(card.count,1);assert.equal(card.showInFeed,false);
  const hidden=await action('feed.list',{schoolId:'bjtu',sourceId:source.id});assert.ok(hidden.ok);assert.deepEqual((hidden.data as any).items,[]);
  await repo.setSourceFeedVisibility!('owner','bjtu',source.id,true);
  const feed=await action('feed.list',{schoolId:'bjtu',sourceId:source.id});assert.ok(feed.ok);assert.equal((feed.data as any).items.length,1);
  const stored=(await sql.query("SELECT id,body FROM campus_documents WHERE collection='items' AND body->>'sourceId'=$1",[source.id])).rows[0]!;
  const material=await service.material({...stored.body,_id:stored.id});assert.match(material.contentText!,/本地合成竞赛通知/);const expires=material.materialExpiresAt;
  at+=3600001;const repeated=await action('sources.public.refresh',{schoolId:'bjtu',sourceId:source.id});assert.ok(repeated.ok);assert.equal((repeated.data as any).stats.newCount,0);
  assert.equal((await sql.query("SELECT body FROM campus_documents WHERE collection='items' AND id=$1",[stored.id])).rows[0]!.body.materialExpiresAt,expires);
  await materialJobs(sql,{school:async()=>{},source:async()=>{},material:async()=>{},cleanup:async()=>({expired:0,deleted:0})},()=>at).start();
  assert.equal((await sql.query("SELECT id FROM campus_collection_jobs WHERE kind='source' AND target_id=$1",[source.id])).rows.length,0);
  assert.equal((await sql.query("SELECT id FROM campus_documents WHERE collection IN ('web_ai_tasks','web_ai_accounts')")).rows.length,0);
 }finally{await pool.end();await server.stop();}
});

test('failed manual attempts persist useful status, enforce cooldown and reject forged IDs or another school before reading',async()=>{
 const server=new NetlifyDB({logger(){}}),pool=getDatabase({connectionString:await server.start()}).pool,sql=pool as unknown as SqlPool,repo=postgresRepository(sql);let at=Date.now(),reads=0;
 const directory=schoolDirectory(sql,repo,async()=>{throw new Error('no school IO');}),service=publicSources(sql,repo,{async publicPage(){reads++;throw new AppError('SOURCE_RESTRICTED','来源网页拒绝公开读取，请查看原站。');},async publicDownload():Promise<never>{throw new Error('no file');}},directory.sources,undefined,()=>at);
 const gateway=createGateway(repo,{ownerUid:'user',dataOwnerId:'owner'},()=>at,{websites:service});
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));await repo.selectSchool('owner','bjtu');
  await assert.rejects(()=>service.handle('sources.public.refresh',{schoolId:'bjtu',sourceId:source.id},{uid:'user',dataOwnerId:'owner',legacyLinked:false}),{code:'SOURCE_RESTRICTED'});assert.equal(reads,1);
  const card=(await service.catalogue('bjtu','owner')).sources.find(row=>row.id===source.id)!;assert.equal(card.state,'unavailable');assert.equal(card.errorCode,'SOURCE_RESTRICTED');assert.ok(card.checkedAt);assert.match(card.message,/拒绝公开读取/);
  await assert.rejects(()=>service.handle('sources.public.refresh',{schoolId:'bjtu',sourceId:source.id},{uid:'user',dataOwnerId:'owner',legacyLinked:false}),{code:'SOURCE_INTERVAL'});assert.equal(reads,1);
  for(const input of [{schoolId:'bjtu',sourceId:'forged'}, {schoolId:'school_002',sourceId:source.id}, {schoolId:'bjtu',sourceId:source.id,url:'https://arbitrary.example.org/'}])assert.equal((await gateway({action:'sources.public.refresh',input},{uid:'user',isAnonymous:false})).ok,false);
  assert.equal((await gateway({action:'sources.public.refresh',input:{schoolId:'bjtu',sourceId:source.id}},{uid:'user',isAnonymous:true})).ok,false);assert.equal(reads,1);
 }finally{await pool.end();await server.stop();}
});

test('manual sources retain existing request budgets and robots rules, and file entries report their unsupported type',async()=>{
 const server=new NetlifyDB({logger(){}}),pool=getDatabase({connectionString:await server.start()}).pool,sql=pool as unknown as SqlPool,repo=postgresRepository(sql);let reads=0,at=Date.now();
 const websites=websiteSources(sql,repo,async url=>{reads++;return{url,html:'User-agent: *\nDisallow: /'};},()=>at,async()=>{at+=1550;});
 const directory=schoolDirectory(sql,repo),service=publicSources(sql,repo,websites,directory.sources,undefined,()=>at),identity={uid:'user',dataOwnerId:'owner',legacyLinked:false};
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));await repo.selectSchool('owner','bjtu');
  await sql.query("UPDATE campus_documents SET body=body || $1::jsonb WHERE collection='user_profiles' AND id='owner'",[JSON.stringify({websiteFetchDay:new Date(at+8*3600000).toISOString().slice(0,10),websiteFetchCount:60})]);
  await assert.rejects(()=>service.handle('sources.public.refresh',{schoolId:'bjtu',sourceId:source.id},identity),{code:'SOURCE_DAILY_LIMIT'});assert.equal(reads,0);
  at+=300001;await sql.query("UPDATE campus_documents SET body=body || '{\"websiteFetchCount\":0}'::jsonb WHERE collection='user_profiles' AND id='owner'");
  await assert.rejects(()=>service.handle('sources.public.refresh',{schoolId:'bjtu',sourceId:source.id},identity),{code:'SOURCE_ROBOTS_BLOCKED'});assert.equal(reads,1);
  const file=competitionDirectory.find(row=>row.number===20)!;
  await assert.rejects(()=>service.handle('sources.public.refresh',{schoolId:'bjtu',sourceId:file.id},identity),{code:'SOURCE_UNSUPPORTED_TYPE'});assert.equal(reads,1);
  const status=(await service.catalogue('bjtu','owner')).sources.find(row=>row.id===file.id)!;assert.equal(status.state,'unavailable');assert.equal(status.errorCode,'SOURCE_UNSUPPORTED_TYPE');assert.match(status.message,/文件/);
 }finally{await pool.end();await server.stop();}
});

test('changing a public source to private while a manual read is in flight prevents publication',async()=>{
 const server=new NetlifyDB({logger(){}}),pool=getDatabase({connectionString:await server.start()}).pool,sql=pool as unknown as SqlPool,repo=postgresRepository(sql),directory=schoolDirectory(sql,repo);
 let reads=0;const service=publicSources(sql,repo,{async publicPage(url){reads++;await sql.query("UPDATE campus_documents SET body=body || '{\"scope\":\"private\",\"ownerOpenid\":\"different-owner\"}'::jsonb WHERE collection='sources' AND id=$1",[source.id]);return{url,html:'<ul><li><a href="/info/1001/99001.htm">本地竞赛通知不应公开发布</a></li></ul>'};},async publicDownload():Promise<never>{throw new Error('no files');}},directory.sources);
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));await repo.selectSchool('owner','bjtu');
  await sql.query("INSERT INTO campus_documents(collection,id,body) VALUES('sources',$1,$2::jsonb)",[source.id,JSON.stringify({name:source.name,scope:'global',entryUrl:source.entryUrl})]);
  await assert.rejects(()=>service.handle('sources.public.refresh',{schoolId:'bjtu',sourceId:source.id},{uid:'user',dataOwnerId:'owner',legacyLinked:false}),{code:'STALE_SOURCE'});
  assert.equal((await sql.query("SELECT id FROM campus_documents WHERE collection='items' AND body->>'sourceId'=$1",[source.id])).rows.length,0);
  await assert.rejects(()=>service.handle('sources.public.refresh',{schoolId:'bjtu',sourceId:source.id},{uid:'user',dataOwnerId:'owner',legacyLinked:false}),{code:'NOT_FOUND'});assert.equal(reads,1);
 }finally{await pool.end();await server.stop();}
});
