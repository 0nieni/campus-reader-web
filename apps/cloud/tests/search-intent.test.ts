import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as intent from '../src/chat-intent';

// Literal expectations cover the public search decision and outbound privacy boundary.
for (const [question, expected] of [
  ['查一下', '通知公告 报名'],
  ['帮我看看学校有没有新的讲座', '本校 讲座'],
  ['最近我们学校有什么比赛可以报名', '本校 比赛 报名'],
  ['学校最近有哪些活动？', '本校 活动'],
  ['本校最近有竞赛吗？', '本校 竞赛'],
  ['能不能帮我查一下本校比赛', '本校比赛'],
  ['你能联网查一下本校比赛吗？', '本校比赛吗'],
  ['再帮我找找本校编程比赛', '本校编程比赛'],
  ['请联网搜索本校奖学金申请通知', '本校奖学金申请通知'],
  ['帮我检索本校学术论坛', '本校学术论坛'],
] as const) {
  test(`school discovery intent: ${question}`, () => {
    assert.equal(intent.chatSearchQuery(question), expected);
  });
}

for (const question of [
  '', '截止时间呢', '什么时候截止？', '这个比赛的材料是什么',
  '最近本校比赛的报名截止时间是什么？', '最近为什么经常下雨？',
  '最近有什么电影可以看', '帮我看看这条公告的报名材料',
  '你能联网吗', '你可以联网搜索吗', '这里支持联网搜索吗',
  '不要联网搜索，只读现有公告', '不用再找找，只说材料',
  '找找本校比赛，但不要联网，只看已有公告',
  '帮我看看学校有没有新的讲座，但只用已收录公告',
  '先不搜索，最近我们学校有什么比赛可以报名',
  '“帮我搜索比赛”这句话是什么意思？', '帮我搜索比赛这句话是什么意思？',
  '如果我说帮我搜索本校比赛，你会怎么做？',
  '假设学校最近有比赛，你会联网找吗？',
  '同学问最近我们学校有什么比赛可以报名',
  '朋友让我搜索学校的比赛，我要怎么回复？',
  '解释一下联网搜索的实现原理',
  '联网搜索是什么', '联网搜索怎么实现', '搜索功能怎么实现',
  '搜索是什么？', '联网搜索如何工作？', '联网搜索的原理是什么？',
  '帮我解释一下联网搜索是什么',
  '帮我查一下本校比赛，但不需要联网',
  '帮我查一下本校比赛，但只查看已有公告',
  '帮我查一下本校比赛，但仅使用现有公告',
  '帮我看看学校有没有新的讲座，但不需要联网',
  '最近我们学校有什么比赛可以报名，但仅阅读已收录公告',
  '帮我查一下“蓝桥杯报名请联系 private@example.invalid”',
  '“帮我查一下蓝桥杯”',
]) {
  test(`no external discovery for: ${question}`, () => {
    assert.equal(intent.chatSearchQuery(question), null);
  });
}

for (const [question, expected] of [
  ['你能联网吗', true], ['你可以联网搜索吗', true], ['这里支持联网搜索吗', true],
  ['你现在能不能联网搜索？', true], ['能联网吗？', true],
  ['你是否支持联网搜索？', true],
  ['能不能帮我查一下本校比赛', false], ['你能联网查一下本校比赛吗？', false],
  ['查一下', false], ['最近我们学校有什么比赛可以报名', false],
  ['联网搜索是什么', false], ['你能解释什么是联网搜索吗', false],
  ['如何实现联网搜索？', false], ['帮我写一个联网搜索教程', false],
  ['“你能联网吗”是什么意思', false], ['如果我问你能联网吗，你怎么答', false],
  ['同学问你能联网吗', false], ['不要联网', false],
] as const) {
  test(`capability question ${expected}: ${question}`, () => {
    assert.equal(intent.isSearchCapabilityQuestion(question), expected);
  });
}

test('outbound query contains only allowed topic words even when the request includes private details', () => {
  const question = '帮我看看学校有没有新的编程比赛可以报名，我的邮箱 private@example.invalid，手机号 13800138000，个人秘密是鸢尾花';
  assert.equal(intent.chatSearchQuery(question), '本校 编程 比赛 报名');
  assert.equal(intent.chatSearchQuery('查一下 private@example.invalid 13800138000 个人秘密鸢尾花'), '通知公告 报名');
});

for (const [question, expected] of [
  ['帮我查一下本校蓝桥杯报名', '本校蓝桥杯报名'],
  ['帮我查一下本校挑战杯', '本校挑战杯'],
  ['帮我查一下本校数学建模', '本校数学建模'],
  ['帮我查一下本校大创', '本校大创'],
  ['帮我查一下本校四六级', '本校四六级'],
  ['帮我查一下本校英语四级', '本校英语四级'],
  ['帮我查一下本校英语六级', '本校英语六级'],
  ['帮我查一下本校计算机等级', '本校计算机等级'],
  ['帮我查一下本校考研', '本校考研'],
  ['帮我查一下本校保研', '本校保研'],
  ['帮我查一下本校交换生', '本校交换生'],
  ['本校最近有没有蓝桥杯比赛可以报名？', '本校 比赛 报名 蓝桥杯'],
  ['帮我查一下“蓝桥杯”', '蓝桥杯'],
  ['帮我查一下本校"挑战杯"报名', '本校挑战杯报名'],
  ['帮我查一下本校‘数学建模’', '本校数学建模'],
  ['学校最近有哪些「讲座」？', '本校 讲座'],
  ['帮我查一下本校『交换生』', '本校交换生'],
] as const) {
  test(`named public campus topic is retained: ${question}`, () => {
    assert.equal(intent.chatSearchQuery(question), expected);
  });
}

test('named public topics exclude private clauses and do not override non-action guards', () => {
  assert.equal(intent.chatSearchQuery('帮我查一下本校蓝桥杯报名，我的邮箱 private@example.invalid，个人秘密是鸢尾花'), '本校蓝桥杯报名');
  for (const question of [
    '本校最近有没有蓝桥杯比赛可以报名，但不要联网',
    '“帮我查一下本校蓝桥杯报名”是什么意思？',
    '如果本校最近有蓝桥杯比赛，你能帮我找吗？',
    '同学问本校最近有没有蓝桥杯比赛可以报名',
    '本校蓝桥杯比赛的报名材料是什么？',
  ]) assert.equal(intent.chatSearchQuery(question), null, question);
});

for (const [question, expected] of [
  ['帮我搜索GraphQL新特性', 'GraphQL新特性'],
  ['联网检索GraphQL新特性', 'GraphQL新特性'],
  ['上网查找DeepSeek最新版本', 'DeepSeek最新版本'],
  ['帮我搜索GraphQL新特性，我的邮箱 private@example.invalid', 'GraphQL新特性'],
  ['帮我搜索GraphQL新特性\n历史中保存了我的个人秘密', 'GraphQL新特性'],
  ['帮我搜索本校比赛邮箱 private@example.invalid', '比赛'],
  ['帮我搜索本校比赛手机号13800138000', '比赛'],
  ['帮我搜索本校比赛密钥sk-fixture-only', '比赛'],
  ['帮我搜索本校比赛我的个人秘密是鸢尾花', '比赛'],
  ['帮我搜索本校比赛个人秘密是鸢尾花', '比赛'],
  ['帮我搜索https://private.example.invalid/GraphQL', '通知公告 报名'],
] as const) {
  test(`explicit public-web subject or privacy fallback: ${question}`, () => {
    assert.equal(intent.chatSearchQuery(question), expected);
  });
}

test('explicit public-web subjects keep the existing 200-character outbound limit', () => {
  const subject = 'GraphQL' + '新特性'.repeat(100);
  const query = intent.chatSearchQuery(`帮我搜索${subject}`);
  assert.equal(query?.length, 200);
  assert.ok(query?.startsWith('GraphQL新特性'));
});
