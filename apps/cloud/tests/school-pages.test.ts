import assert from 'node:assert/strict';import{test}from'node:test';
import{extractNotices,extractArticle,approvedSchoolUrl,type SchoolSource}from'../src/school-pages';import{schoolSources}from'../src/school-sources';
const school:SchoolSource={id:'school_001',name:'北京大学',homepage:'https://www.pku.edu.cn/',announcementUrl:'https://dean.pku.edu.cn/web/notice.php'};
test('public article form wrappers preserve text while controls, CSS and scripts are excluded',()=>{
 const text=extractArticle({url:school.announcementUrl,html:'<form name="_newscontent_fromname"><input value="not content"><div class="v_news_content"><style>not content</style><p>这是学校公开通知的正文，说明竞赛报名条件、材料要求和评选流程，详情以学校通知为准。</p><script>not content</script></div></form>'});
 assert.match(text,/公开通知/);assert.ok(!text.includes('not content'));
 assert.throws(()=>extractArticle({url:school.announcementUrl,html:'<form><div class="v_news_content"><img src="poster.jpg"></div></form>'}),{code:'NO_MATERIAL'});
 assert.throws(()=>extractArticle({url:school.announcementUrl,html:'<title>身份服务系统</title><input type="password"><article>受限内容</article>'}),{code:'SOURCE_LOGIN_REQUIRED'});
 assert.throws(()=>extractNotices({url:school.announcementUrl,html:'<script>location="/dynamic_challenge"</script>'},school),{code:'SOURCE_RESTRICTED'});
 assert.throws(()=>approvedSchoolUrl('https://webvpn.pku.edu.cn/https/example',school),{code:'SOURCE_LOGIN_REQUIRED'});
});
test('known CMS formats and separated date markup retain exact dates without reading dates from a title',()=>{
 const html=`<ul><li><a href='/web/notice_details.php?id=768'><h5>新生学籍信息填写通知</h5><i>2026.10.13</i></a></li>
 <li><a href='/ab/cd/c123a456/page.htm'><div class='date'><span>05</span><em>2026/10</em></div><h4>公开课程报名通知</h4></a></li>
 <li><dl><dt>17</dt><dd>2026-09</dd></dl><a href='/202604/t20260428_1396482.shtml'>学校公开节假日安排</a></li>
 <li><a href='/info/1202/1234.htm'>关于2026年11月15日截止的通知</a></li><li><a href='/info/1202/1235.htm'>报名截止至<span>2026-11-15</span>的竞赛通知</a></li></ul>`;
 const rows=extractNotices({url:school.announcementUrl,html},school);assert.equal(rows.length,5);
 assert.equal(rows[0]!.title,'新生学籍信息填写通知');assert.equal(rows[0]!.publishedAt,'2026-10-12T16:00:00.000Z');
 assert.equal(rows[1]!.publishedAt,'2026-10-04T16:00:00.000Z');assert.equal(rows[2]!.publishedAt,'2026-09-16T16:00:00.000Z');assert.equal(rows[3]!.publishedAt,null);assert.equal(rows[4]!.publishedAt,null);
});
test('comma-separated source scopes select anchors in every column and exclude unrelated news',()=>{
 const rows=extractNotices({url:school.announcementUrl,html:`<div class='one'><a href='/info/1/1111.htm'>第一栏公开通知</a></div><div class='two'><a href='/info/1/2222.htm'>第二栏公开通知</a></div><div><a href='/info/1/3333.htm'>不在栏目中的新闻</a></div>`},{...school,listSelector:'.one,.two'});
 assert.equal(rows.length,2);assert.ok(rows.every(r=>!r.title.includes('新闻')));
 const pku=schoolSources({...school,status:'candidate'});assert.match(pku.sources[0]!.announcementUrl,/dean.pku/);assert.match(pku.note,/教务部/);
 const thu=schoolSources({id:'school_002',name:'清华大学',status:'candidate',homepage:'https://www.tsinghua.edu.cn/',announcementUrl:'https://info.tsinghua.edu.cn/'});assert.equal(thu.sources.length,2);assert.ok(thu.sources.every(s=>!s.announcementUrl.includes('info.tsinghua')));assert.match(thu.note,/院系/);
});
test('navigation links and unresolved template URLs cannot masquerade as school notices',()=>{
 const html=`<div id='wp_nav_w3'><a href='/2026/1001/c1a1234/page.htm'>科研机构</a></div><div class='menu-item'><a href='/info/1/1234.htm'>网上信访</a></div><ul><li><a href='/page/{{link}}'>未填充模板中的通知</a></li><li><a href='/info/1/2345.htm'><h3>20</h3><h4>真正公开的竞赛报名通知</h4><p>${'内容简介'.repeat(80)}</p></a></li></ul>`;
 const rows=extractNotices({url:school.announcementUrl,html},school);assert.equal(rows.length,1);assert.equal(rows[0]!.title,'真正公开的竞赛报名通知');
});
