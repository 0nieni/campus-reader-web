import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import {postgresRepository} from '../src/postgres-repository';
import type {SqlPool} from '../src/postgres-storage';
import {createGateway} from '../src/gateway';
import {competitionSources} from '../src/competition-sources';
import {publicSources} from '../src/public-sources';
import {schoolDirectory} from '../src/school-directory';
import {materialArchive} from '../src/material-archive';
import {materialJobs} from '../src/material-jobs';

test('source opt-in applies before pagination and exact-source filters never reveal an unchecked source',async()=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),pool=getDatabase({connectionString}).pool,sql=pool as unknown as SqlPool;
 const repo=postgresRepository(sql),caller={uid:'source-owner',isAnonymous:false};
 const gateway=createGateway(repo,{ownerUid:caller.uid,dataOwnerId:'owner'});
 const action=(action:string,input:Record<string,unknown>)=>gateway({action,input},caller);
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
  await repo.selectSchool('owner','school_002');
  const sourceId=competitionSources[0]!.id;
  for(let i=0;i<25;i++)await sql.query("INSERT INTO campus_documents(collection,id,body) VALUES('items',$1,$2::jsonb)",[String(i).padStart(3,'0'),JSON.stringify({title:'本地公开竞赛公告 '+i,sourceId,sourceName:'合成来源',scope:'global',status:'published',categories:['competition'],publishedAt:new Date().toISOString()})]);
  const initial=await action('feed.list',{schoolId:'school_002',sourceId});assert.ok(initial.ok);assert.deepEqual((initial.data as {items:unknown[]}).items,[]);
  assert.ok((await action('sources.feedVisibility',{schoolId:'school_002',sourceId,visible:true})).ok);
  const page=await action('feed.list',{schoolId:'school_002',sourceId});assert.ok(page.ok);assert.equal((page.data as {items:unknown[]}).items.length,20);assert.equal((page.data as {nextCursor:string}).nextCursor,'20');
  const next=await action('feed.list',{schoolId:'school_002',sourceId,cursor:'20'});assert.ok(next.ok);assert.equal((next.data as {items:unknown[]}).items.length,5);
  assert.ok((await action('sources.feedVisibility',{schoolId:'school_002',sourceId,visible:false})).ok);
  const hidden=await action('feed.list',{schoolId:'school_002',sourceId});assert.ok(hidden.ok);assert.deepEqual((hidden.data as {items:unknown[]}).items,[]);
  const candidates=await repo.items(await repo.scope('school_002','owner'),0,100,new Date(Date.now()-86400000).toISOString());assert.equal(candidates.filter(item=>item.sourceId===sourceId).length,25);
  const other=await action('sources.feedVisibility',{schoolId:'school_002',sourceId:'other-users-private-source',visible:true});assert.equal(other.ok,false);
 }finally{await pool.end();await server.stop();}
});

test('public catalogue is read-only, collection is scoped/deduplicated, and retained material uses the existing global archive',async()=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),pool=getDatabase({connectionString}).pool,sql=pool as unknown as SqlPool,repo=postgresRepository(sql);
 let at=Date.now(),reads=0;const owner='catalogue-owner',source=competitionSources[0]!,objects=new Map<string,Uint8Array>();
 const archive=materialArchive(sql,{async put(key,bytes){objects.set(key,bytes);},async get(key){return objects.get(key)||null;},async remove(key){objects.delete(key);} },'public-test',{now:()=>at});
 const school=schoolDirectory(sql,repo,async()=>{throw new Error('directory reads must not fetch');});
 const readers={async publicPage(url:string){reads++;return{url,html:url===source.entryUrl?`<ul><li><time>${new Date(at).toISOString().slice(0,10)}</time><a href="/info/1042/9001.htm">合成公开竞赛报名通知一</a></li><li><a href="/info/1042/9002.htm">合成公开竞赛报名通知二</a></li></ul>`:'<div class="article-content"><p>这是合成的公开竞赛公告正文，用于验证报名时间、参赛要求和材料说明进入现有资料库。请按通知要求准备参赛作品并核对主办方的具体安排。</p></div>'};},async publicDownload():Promise<never>{throw new Error('no attachments in fixture');}};
 const service=publicSources(sql,repo,readers,school.sources,archive,()=>at);
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));await repo.selectSchool(owner,'school_002');
  const catalogue=await service.catalogue('school_002',owner);assert.ok(catalogue.sources.filter(row=>row.kind==='school').every(row=>row.showInFeed));assert.ok(catalogue.sources.filter(row=>row.kind!=='school').every(row=>!row.showInFeed));assert.equal(reads,0);
  const first=await service.refreshSource(source.id,owner);assert.deepEqual(first.stats,{newCount:2,existingCount:0,failedSources:0,skippedCount:0});assert.equal(reads,1);
  await assert.rejects(()=>service.refreshSource(source.id,owner),{code:'SOURCE_INTERVAL'});assert.equal(reads,1);
  await assert.rejects(()=>service.refreshSource('unverified-site',owner),{code:'NOT_FOUND'});assert.equal(reads,1);
  const record=(await sql.query("SELECT body FROM campus_documents WHERE collection='sources' AND id=$1",[source.id])).rows[0]!.body;assert.equal(record.scope,'global');assert.equal(record.ownerOpenid,undefined);
  const row=(await sql.query("SELECT id,body FROM campus_documents WHERE collection='items' AND body->>'sourceId'=$1 ORDER BY id",[source.id])).rows[0]!;
  const material=await service.material({...row.body,_id:row.id});assert.match(material.contentText!,/合成的公开竞赛公告正文/);assert.equal(objects.size,1);const expiry=material.materialExpiresAt;
  at+=3600001;const repeated=await service.refreshSource(source.id,owner);assert.equal(repeated.stats.newCount,0);assert.equal(repeated.stats.existingCount,2);
  const kept=(await sql.query("SELECT body FROM campus_documents WHERE collection='items' AND id=$1",[row.id])).rows[0]!.body;assert.equal(kept.materialExpiresAt,expiry);
  await repo.setSourceFeedVisibility!(owner,'school_002',source.id,true);
  const jobs=materialJobs(sql,{school:async()=>{},source:async()=>{},material:async()=>{},cleanup:async()=>({expired:0,deleted:0})},()=>at);await jobs.start();await jobs.start();
  const scheduled=await sql.query("SELECT target_id,owner_key,school_id FROM campus_collection_jobs WHERE kind='source' AND owner_key='' AND school_id='global'");assert.deepEqual(scheduled.rows,[{target_id:source.id,owner_key:'',school_id:'global'}]);
  assert.equal((await sql.query("SELECT id FROM campus_documents WHERE collection IN ('web_ai_tasks','web_ai_accounts')")).rows.length,0);
 }finally{await pool.end();await server.stop();}
});
