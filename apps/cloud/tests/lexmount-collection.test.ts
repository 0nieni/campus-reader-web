import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import {lexmountReader} from '../src/lexmount-pages';
import {schoolDirectory} from '../src/school-directory';
import {schoolSources} from '../src/school-sources';
import {websiteSources} from '../src/website-sources';
import {postgresRepository} from '../src/postgres-repository';
import {materialArchive} from '../src/material-archive';
import type {SqlPool} from '../src/postgres-storage';
import {fixturePdf} from './material-fixtures';

test('rendered Lexmount pages enter the existing scoped SQL/archive pipeline and raw personal feeds keep their protocol',async t=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),pool=getDatabase({connectionString}).pool;(pool as any).options.max=1;
 const sql=pool as unknown as SqlPool,repo=postgresRepository(sql),objects=new Map<string,Uint8Array>();
 let at=Date.now(),cloudCalls=0,rawCalls=0,downloads=0;
 const config={apiKey:'fixture-key-not-real',projectId:'fixture-project'},resolve=async()=>[{address:'8.8.8.8'}];
 const archive=materialArchive(sql,{async put(key,bytes){objects.set(key,bytes);},async get(key){return objects.get(key)||null;},async remove(key){objects.delete(key);} },'lexmount-test',{now:()=>at,download:async url=>{downloads++;return{url,bytes:fixturePdf(),contentType:'application/pdf'};}});
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
  const school=(await repo.school('school_001'))!,entry=schoolSources(school).sources[0]!;
  const reader=lexmountReader({config:()=>config,resolve,request:async(_url,init)=>{
   cloudCalls++;const {url}=JSON.parse(String(init!.body));
   return Response.json({status_code:200,final_url:url,html:url===entry.announcementUrl?'<ul><li><time>2026-10-25</time><a href="/web/notice_details.php?id=87654">合成项目报名公告通知</a></li></ul>':'<div class="newsinfo_box"><p>本篇合成通知用于验证渲染后正文的数据库保存，请准备申请材料并核对参与条件，具体时间和要求以附件为准。</p><a href="/uploads/fixture.pdf">材料.pdf</a></div>'});
  },direct:async url=>{rawCalls++;return{url,html:url.endsWith('/robots.txt')?'User-agent: *\nDisallow: /private':JSON.stringify({data:{list:[{title:'合成个人来源公告',url:'/notice.htm',content:'合成的个人来源正文包含公开项目报名条件、活动安排以及材料要求，请核对后按规定时间提交申请。'}]}})};}});
  const directory=schoolDirectory(sql,repo,reader,()=>at,{archive});repo.material=directory.material;
  await t.test('list and rendered body parsing preserve IDs, attachments and the one-year cache',async()=>{
   assert.equal((await directory.refresh(school.id)).count,1);await repo.selectSchool('fixture-owner',school.id);
   const rows=await sql.query("SELECT id,body FROM campus_documents WHERE collection='items' AND body->>'sourceId'=$1",['directory_school_001__teaching']);
   const row={...rows.rows[0].body,_id:rows.rows[0].id},saved=await repo.material!(row);
   assert.match(saved.contentText!,/渲染后正文/);assert.match(saved.contentText!,/Synthetic campus material/);assert.equal(saved.materialArchive!.files.length,2);assert.equal(cloudCalls,2);assert.equal(downloads,1);assert.equal(rawCalls,0);
   const again=await repo.material!(saved);assert.equal(again.materialExpiresAt,saved.materialExpiresAt);assert.equal(cloudCalls,2);assert.equal(downloads,1);
   await sql.query("UPDATE campus_documents SET body=body || '{\"enabled\":false}'::jsonb WHERE collection='sources' AND id=$1",[row.sourceId]);
   await assert.rejects(()=>repo.material!(saved),{code:'NOT_FOUND'});assert.equal(cloudCalls,2);
  });
  await t.test('robots/JSON remain raw while the resulting authorized body is stored with fixed expiry',async()=>{
   const websites=websiteSources(sql,repo,reader,()=>at,async ms=>{at+=ms;},archive),identity={uid:'fixture-uid',dataOwnerId:'fixture-owner',legacyLinked:false};
   const source={name:'合成 JSON 来源',entryUrl:'https://notice.example.edu.cn/data.json',type:'json_api',categories:['school'],selectors:{},intervalMinutes:15,allowAi:true,authorized:true};
   const added=await websites.handle('sources.save',{schoolId:school.id,source},identity) as {id:string};
   await websites.handle('sources.refresh',{schoolId:school.id,sourceId:added.id},identity);
   const result=(await sql.query("SELECT body FROM campus_documents WHERE collection='items' AND body->>'sourceId'=$1",[added.id])).rows[0].body;
   assert.match(result.contentText,/个人来源正文/);assert.ok(result.materialExpiresAt);assert.equal(result.ownerOpenid,identity.dataOwnerId);assert.equal(cloudCalls,2);assert.equal(rawCalls,2);
  });
 }finally{await pool.end();await server.stop();}
});
