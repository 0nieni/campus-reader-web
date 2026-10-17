import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NetlifyDB } from '@netlify/database-dev';
import { getDatabase } from '@netlify/database';
import { postgresRepository } from '../src/postgres-repository';
import { schoolDirectory } from '../src/school-directory';
import { schoolRequests,schoolName } from '../src/school-requests';
import { approvedSchoolUrl,extractArticle,extractNotices,fullDate,type SchoolSource } from '../src/school-pages';
import { createGateway } from '../src/gateway';
import type { SqlPool } from '../src/postgres-storage';
const school: SchoolSource = {id:'school_001',name:'北京大学',announcementUrl:'https://www.pku.edu.cn/notices.html',homepage:'https://www.pku.edu.cn/'};
const html = `<html><title>通知公告</title><nav><a href="/info/1/9988.htm">网站导航栏目不应采集</a></nav><ul>
<li><time>2026-10-17</time><a href="/info/1001/10001.htm">关于学生竞赛报名的通知</a></li>
<li><span class="date">10-17</span><a href="/info/1001/10002.htm">关于学生讲座报名的通知</a></li>
<li><a href="/info/1001/10003.htm">关于2026年11月15日报名截止的通知</a></li>
<li><a href="https://other.edu.cn/info/1001/10004.htm">别校公告不能混入本校列表</a></li>
<li><a href="javascript:alert(1)">不可执行的公告地址测试</a></li><li><a href="/files/form.pdf">通知附件不能冒充公告</a></li></ul></html>`;
test('school extraction keeps public article links, source dates and text without inferring a publication date from a deadline',()=>{
  const notices=extractNotices({html,url:school.announcementUrl},school);
  assert.equal(notices.length,3);assert.equal(notices[0]!.publishedAt,'2026-10-16T16:00:00.000Z');
  assert.equal(notices[1]!.publishedAt,null);assert.equal(notices[2]!.publishedAt,null);
  assert.equal(fullDate('2026-02-30'),null);assert.equal(fullDate('10-17'),null);
  assert.equal(extractArticle({url:school.announcementUrl,html:'<article><p>这是一篇真实结构的测试公告，说明报名方式和截止时间，正文保留普通文字。</p><script>alert(1)</script><p>请以附件为准。</p></article>'}).includes('alert'),false);
  assert.throws(()=>extractNotices({html:'<title>统一身份认证</title><input type=password>',url:school.announcementUrl},school));
  for(const url of ['https://127.0.0.1/','https://www.pku.edu.cn.evil.test/a','https://user:pass@www.pku.edu.cn/a','https://www.pku.edu.cn:444/a','file:///a']) assert.throws(()=>approvedSchoolUrl(url,school));
  assert.equal(approvedSchoolUrl('https://news.pku.edu.cn/info/1/2.htm',school).hostname,'news.pku.edu.cn');
  assert.equal(schoolName(' 某某大学（新校区） '),'某某大学(新校区)');
  for(const name of ['a','<script>大学</script>','大学\nBcc:xx@evil.test','https://evil.test','甲'.repeat(81)]) assert.throws(()=>schoolName(name));
});
test('school migrations, cached public feeds and idempotent authenticated school applications use real local SQL',async t=>{
  const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),pool=getDatabase({connectionString}).pool;
  (pool as unknown as {options:{max:number}}).options.max=1;
  const sql=pool as unknown as SqlPool,repo=postgresRepository(sql);
  try {
    await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
    await t.test('all 115 schools paginate once, preserve BJTU and retain the 27 imported notices',async()=>{
      const all=[...await repo.schools(0,50),...await repo.schools(50,50),...await repo.schools(100,50)];
      assert.equal(all.length,115);assert.equal(new Set(all.map(row=>row.id)).size,115);assert.equal(all.filter(row=>row.tags?.includes('985')).length,39);
      assert.equal(all[0]!.id,'bjtu');assert.equal(all[0]!.status,'ready');assert.equal(all[114]!.name,'石河子大学');
      assert.equal(Number((await sql.query("SELECT count(*) FROM campus_documents WHERE collection='items'")).rows[0].count),27);
    });
    let reads=0;
    const directory=schoolDirectory(sql,repo,async url=>{reads++;return {url,html:url===school.announcementUrl?html:'<article><p>公开公告测试正文：关于学生竞赛报名的通知，请在规定时间内完成报名，详细安排以原文附件为准。</p></article>'};});
    repo.material=directory.material;
    await t.test('school refresh caches a scoped feed; article bodies are fetched lazily and cached',async()=>{
      assert.equal((await directory.refresh(school.id)).count,3);await directory.refresh(school.id);assert.equal(reads,1);
      await repo.selectSchool('member',school.id);
      const gateway=createGateway(repo,{ownerUid:'uid',dataOwnerId:'member'}),caller={uid:'uid',isAnonymous:false};
      const feed=await gateway({action:'feed.list',input:{schoolId:school.id}},caller);assert.ok(feed.ok);assert.equal((feed.data as any).items.filter((row:any)=>row.id.startsWith('notice_')).length,3);
      const id=(feed.data as any).items.find((row:any)=>row.id.startsWith('notice_')).id;
      const detail=await gateway({action:'feed.detail',input:{schoolId:school.id,itemId:id}},caller);assert.ok(detail.ok);assert.match((detail.data as any).text,/公开公告/);
      await gateway({action:'feed.detail',input:{schoolId:school.id,itemId:id}},caller);assert.equal(reads,2);
      const stale=await gateway({action:'feed.detail',input:{schoolId:'bjtu',itemId:id}},caller);assert.equal(stale.ok,false);assert.equal(reads,2);
    });
    await t.test('failed sources stay explicit and do not erase existing notices or become ready',async()=>{
      const failed=schoolDirectory(sql,repo,async()=>{throw new Error('raw credentials must not leak');});
      const result=await failed.refresh('school_002');assert.equal(result.state,'unavailable');assert.ok(!JSON.stringify(result).includes('raw credentials'));
      assert.equal((await repo.school('school_002'))!.status,'candidate');
    });
    await t.test('repeated/concurrent applications notify once and daily limits cannot overwrite favorites or change recipient data',async()=>{
      const delivered: URLSearchParams[]=[];
      const request=schoolRequests(sql,async fields=>{delivered.push(fields);});
      const results=await Promise.all(Array.from({length:4},()=>request('其他测试大学','member','member@example.test')));
      assert.equal(new Set(results.map(row=>row.id)).size,1);assert.equal(delivered.length,1);
      assert.equal(delivered[0]!.get('email'),'member@example.test');assert.equal(delivered[0]!.get('form-name'),'school-add-request');
      assert.equal(delivered[0]!.has('recipient'),false);assert.equal(await repo.selectedSchool('member'),school.id);
      await request('第二测试大学','member','member@example.test');await request('第三测试大学','member','member@example.test');
      await assert.rejects(request('第四测试大学','member','member@example.test'),{code:'REQUEST_LIMIT'});
      const unknown=schoolRequests(sql,async()=>{throw new Error('ambiguous connection outcome');});
      assert.equal((await unknown('其他测试大学','another','another@example.test')).state,'unknown');
      await unknown('其他测试大学','another','another@example.test');assert.equal(delivered.length,3);
      const gateway=createGateway(repo,{ownerUid:'uid',dataOwnerId:'member'},Date.now,{directory:{refresh:directory.refresh,request:(name,identity)=>request(name,identity.dataOwnerId,'member@example.test')}});
      const forged=await gateway({action:'school.request',input:{schoolName:'伪造大学',email:'attacker@example.test'}},{uid:'uid',isAnonymous:false});assert.equal(forged.ok,false);
    });
  } finally { await pool.end();await server.stop(); }
});
