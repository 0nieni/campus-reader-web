import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import type {SqlPool} from '../src/postgres-storage';
import {sourceDirectoryAudit,auditHttp,sourceAuditKey,SOURCE_AUDIT_RUN} from '../src/source-directory-audit';
import {publicSources} from '../src/public-sources';
import {postgresRepository} from '../src/postgres-repository';
import {schoolDirectory} from '../src/school-directory';
import {AppError} from '../src/errors';

const at=Date.parse('2026-11-04T12:00:00Z'),key='x'.repeat(43);
test('Node Functions process environment authenticates when the optional Netlify global is absent',async()=>{
 const name='SOURCE_DIRECTORY_AUDIT_KEY_20261104',old=process.env[name],global=globalThis as typeof globalThis&{Netlify?:unknown},oldGlobal=global.Netlify;
 try{Reflect.deleteProperty(global,'Netlify');process.env[name]=key;
  const handler=auditHttp({key:sourceAuditKey,production:()=>true,now:()=>at,run:async()=>({state:'ready'})});
  const response=await handler(new Request('https://example.netlify.app/audit',{method:'POST',headers:{'content-type':'application/json','x-source-audit-key':key},body:JSON.stringify({target:'competition_001'})}));
  assert.equal(response.status,200);
 }finally{if(old===undefined)delete process.env[name];else process.env[name]=old;if(oldGlobal===undefined)Reflect.deleteProperty(global,'Netlify');else global.Netlify=oldGlobal;}
});
test('maintenance authentication, production, expiry and exact request scope are checked before collection',async()=>{
 let calls=0;
 const handler=auditHttp({key:()=>key,production:()=>true,now:()=>at,run:async()=>{calls++;return{state:'ready'};}});
 const request=(body:unknown,token=key)=>new Request('https://example.netlify.app/.netlify/functions/source-directory-audit',{method:'POST',headers:{'x-source-audit-key':token,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await handler(request({target:'competition_001'},'wrong'))).status,403);
 for(const body of [{target:'forged'},{target:'competition_001',url:'https://example.org'},{target:'school_001'},{target:'competition_023'}])assert.equal((await handler(request(body))).status,400);
 assert.equal(calls,0);
 assert.equal((await auditHttp({key:()=>key,production:()=>false,now:()=>at,run:async()=>{calls++;}})(request({target:'competition_001'}))).status,403);
 assert.equal((await auditHttp({key:()=>key,production:()=>true,now:()=>Date.parse('2026-11-06T00:00:00Z'),run:async()=>{calls++;}})(request({target:'competition_001'}))).status,403);
 assert.equal(calls,0);
 const response=await handler(request({target:'competition_001'}));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(!JSON.stringify(await response.json()).includes(key));assert.equal(calls,1);
});

test('fixed maintenance run is once per target, retains failure and does not read or modify personal profiles',async()=>{
 const server=new NetlifyDB({logger(){}}),pool=getDatabase({connectionString:await server.start()}).pool,sql=pool as unknown as SqlPool;
 const seen:string[]=[];
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
  const profilesBefore=(await sql.query("SELECT id,body FROM campus_documents WHERE collection='user_profiles' ORDER BY id")).rows;
  const run=sourceDirectoryAudit(sql,async target=>{seen.push(target);if(target==='competition_002')throw new AppError('SOURCE_PARSE_FAILED','未识别公告列表。');return{count:1,stats:{newCount:1,existingCount:0}};},()=>at);
  const first=await run('competition_001');assert.equal(first.state,'ready');
  assert.equal((await run('competition_001')).cached,true);assert.equal(seen.length,1);
  assert.equal((await run('competition_002')).state,'failed');assert.equal((await run('competition_002')).cached,true);assert.equal(seen.length,2);
  await Promise.all([run('competition_003'),run('competition_003')]);assert.equal(seen.filter(id=>id==='competition_003').length,1);
  await assert.rejects(()=>run('private-source'),{code:'VALIDATION_FAILED'});assert.equal(seen.length,3);
  assert.equal((await sql.query("SELECT count(*)::int AS n FROM campus_documents WHERE collection='school_sync' AND body->>'auditRun'=$1",[SOURCE_AUDIT_RUN])).rows[0].n,3);
  const repo=postgresRepository(sql),directory=schoolDirectory(sql,repo);
  let budgetOwner:string|undefined='not-called';
  const service=publicSources(sql,repo,{async publicPage(url,_config,_id,owner){budgetOwner=owner;return{url,html:'<ul><li><time>2026-11-04</time><a href="/info/1001/99988.htm">仅本机合成的竞赛报名测试通知</a></li></ul>'};},async publicDownload(){throw Error('no download');}},directory.sources,undefined,()=>at);
  const result=await service.maintenanceRefreshSource('competition_001');assert.equal(result.count,1);assert.equal(budgetOwner,undefined);
  assert.equal((await service.catalogue('bjtu','owner')).sources.find(s=>s.id==='competition_001')!.showInFeed,false);
  await assert.rejects(()=>service.maintenanceRefreshSource('forged'),{code:'NOT_FOUND'});
  assert.deepEqual((await sql.query("SELECT id,body FROM campus_documents WHERE collection='user_profiles' ORDER BY id")).rows,profilesBefore);
 }finally{await pool.end();await server.stop();}
});
