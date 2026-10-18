import assert from 'node:assert/strict';import{test}from'node:test';import{fileURLToPath}from'node:url';
import{NetlifyDB}from'@netlify/database-dev';import{getDatabase}from'@netlify/database';
import{warmRecentSchools}from'../src/school-warmup';import{schoolDirectory}from'../src/school-directory';import{postgresRepository}from'../src/postgres-repository';import type{SqlPool}from'../src/postgres-storage';
test('daily public warming is bounded, fair, idempotent and never renews its own activity',async()=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),pool=getDatabase({connectionString}).pool;(pool as unknown as{options:{max:number}}).options.max=1;
 const sql=pool as unknown as SqlPool;let now=Date.parse('2026-10-19T18:17:00Z');const visited=new Date(now-3600000).toISOString();
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
  for(const id of ['school_001','school_002','school_003','school_004','school_005','school_006','not_a_school'])await sql.query("INSERT INTO campus_documents(collection,id,body) VALUES('school_sync',$1,$2::jsonb)",[id,JSON.stringify({state:'ready',retryAt:id==='school_006'?new Date(now+3600000).toISOString():'2000-01-01',lastVisitedAt:id==='school_005'?new Date(now-8*86400000).toISOString():visited})]);
  const calls:string[]=[];const refresh=async(id:string)=>{calls.push(id);return{state:id==='school_002'?'unavailable' as const:'ready' as const,count:1,checkedAt:new Date(now).toISOString(),message:'fixture'};};
  const first=await warmRecentSchools(sql,refresh,()=>now);assert.equal(first.selected,3);assert.equal(first.ready,2);assert.equal(first.unavailable,1);assert.deepEqual(calls,['school_001','school_002','school_003']);
  assert.equal((await warmRecentSchools(sql,refresh,()=>now)).skipped,true);assert.equal(calls.length,3);
  now+=86400000;await warmRecentSchools(sql,refresh,()=>now);assert.equal(calls.length,6);assert.equal(calls[3],'school_004');assert.ok(!calls.includes('school_005'));assert.ok(!calls.includes('not_a_school'));
  const repo=postgresRepository(sql),directory=schoolDirectory(sql,repo,async url=>({url,html:'<ul><li><time>2026-10-18</time><a href="/info/1001/12345.htm">公开教学通知测试</a></li></ul>'}),()=>now,{trackActivity:false});
  const warmed=await directory.refresh('school_001');assert.equal(warmed.changed,true);
  assert.equal((await directory.refresh('school_001')).changed,false);
  assert.equal((await sql.query("SELECT body->>'lastVisitedAt' AS visited FROM campus_documents WHERE collection='school_sync' AND id='school_001'")).rows[0]!.visited,visited);
  now+=3600000+1;assert.equal((await directory.refresh('school_001')).changed,false);
  assert.equal((await sql.query("SELECT body->>'lastVisitedAt' AS visited FROM campus_documents WHERE collection='school_sync' AND id='school_001'")).rows[0]!.visited,visited);
  const visitor=schoolDirectory(sql,repo,async()=>{throw new Error('cached reader must not run');},()=>now);
  await visitor.refresh('school_001');assert.equal((await sql.query("SELECT body->>'lastVisitedAt' AS visited FROM campus_documents WHERE collection='school_sync' AND id='school_001'")).rows[0]!.visited,new Date(now).toISOString());
 }finally{await pool.end();await server.stop();}
});
