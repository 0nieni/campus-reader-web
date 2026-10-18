import assert from 'node:assert/strict';
import {test} from 'node:test';
import {extractSummary,noticeSummary,shortText} from '../src/notice-summary';
import {toNotice} from '../src/gateway';

test('free summaries extract source facts, cap Unicode characters at fifty and mark title-only fallback',()=>{
  const brief=extractSummary('发布时间：2026-10-18\n各位同学：\n请于10月25日前提交竞赛报名材料。\n咨询请联系学校教务处。','竞赛报名通知');
  assert.equal(brief.basis,'body');assert.match(brief.text,/10月25日/);assert.ok(!brief.text.includes('发布时间'));
  assert.ok(Array.from(brief.text).length<=50);
  assert.equal(Array.from(shortText('😀'.repeat(90))).length,50);
  assert.deepEqual(extractSummary('','招聘公告'),{text:'招聘公告',basis:'title'});
  assert.deepEqual(extractSummary('招聘公告','招聘公告'),{text:'招聘公告',basis:'title'});
  const row={_id:'public',title:'活动公告',scope:'school',contentText:'本次活动面向全校学生开放，报名截止10月25日，请在线提交申请。'};
  assert.equal(toNotice(row).summaryBasis,'body');assert.ok(Array.from(toNotice(row).summary!).length<=50);
  assert.equal(noticeSummary({...row,scope:'private',ownerOpenid:'member'}),null);
  assert.equal(toNotice({...row,contentText:undefined}).summaryBasis,'title');
});
