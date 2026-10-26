import assert from 'node:assert/strict';
import {test} from 'node:test';
import {noticeExcerpt} from '../src/notice-excerpt';
import {toNotice} from '../src/gateway';
import {extractArticleTitle} from '../src/school-pages';
test('feed excerpts quote bounded existing body text and never reuse legacy or inferred summaries',()=>{
 const row={_id:'fixture',title:'真实公告标题',contentText:'真实公告标题\n发布时间：2026-10-26\n'+ '请参加活动的同学准备报名材料，核对原通知中的具体时间和要求。'.repeat(8),summary:{oneLine:'禁止回显的旧AI摘要'},autoSummary:{text:'禁止回显的推断',basis:'title' as const,version:'old'}};
 const excerpt=noticeExcerpt(row)!;assert.ok(excerpt.startsWith('请参加活动'));assert.ok(excerpt.length<=121);assert.ok(excerpt.endsWith('…'));assert.doesNotMatch(excerpt,/发布时间|旧AI摘要|推断/);assert.equal(toNotice(row).excerpt,excerpt);assert.equal(toNotice(row).summary,null);
 assert.equal(noticeExcerpt({_id:'empty',summary:{oneLine:'旧摘要'}}),null);
});
test('expired or invalid body lifetimes cannot leak snippets',()=>{
 const row={_id:'fixture',contentText:'这是一段已经过期的原始正文，不应该出现在公告列表的摘录中。'};
 for(const expiry of ['invalid','2026-10-01T00:00:00Z'])assert.equal(noticeExcerpt({...row,materialExpiresAt:expiry},Date.parse('2026-10-26T00:00:00Z')),null);
 assert.equal(noticeExcerpt({...row,aiSearchExpiresAt:'2026-10-01T00:00:00Z'},Date.parse('2026-10-26T00:00:00Z')),null);
});
test('article metadata wins over a column heading and unverified column-only pages are rejected',()=>{
 assert.equal(extractArticleTitle({url:'https://example.edu/notice.htm',html:'<title>关于2027届推免名单的公示</title><h1>研究生招生</h1><h2>关于2027届推免名单的公示</h2>'}),'关于2027届推免名单的公示');
 assert.equal(extractArticleTitle({url:'https://example.edu/notice.htm',html:'<title>通知公告</title><h1>本科生教育</h1><h2>关于课程补考安排的通知</h2>'}),'关于课程补考安排的通知');
 assert.throws(()=>extractArticleTitle({url:'https://example.edu/notice.htm',html:'<title>通知公告</title><h1>研究生招生</h1>'}),{code:'SOURCE_PARSE_FAILED'});
});
