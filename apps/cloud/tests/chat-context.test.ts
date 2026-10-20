import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChatContext } from '../src/chat-context';

test('bounded history stays valid JSON and retains the latest refusal and its actual evidence', () => {
  const exchanges = Array.from({ length: 5 }, (_, index) => ({ question: index === 4 ? '先别给建议，只说材料' : '旧问题'.repeat(200), answer: `第${index}轮回答` + '准备'.repeat(1000), evidence: [{ itemId: `item-${index}`, version: `version-${index}` }] }));
  const context = buildChatContext('bjtu', { interests: ['编程'], goals: '项目经验' }, exchanges, ['竞赛通知']);
  assert.ok(context.history.length <= 3500);
  const decoded = JSON.parse(context.history);
  assert.equal(decoded.historyMayBeIncomplete, true);
  assert.equal(decoded.exchanges.at(-1).user, '先别给建议，只说材料');
  assert.ok(decoded.exchanges.at(-1).assistant.includes('历史内容已缩短'));
  assert.ok(!context.evidence.some(entry => entry.itemId === 'item-0'));
  assert.ok(context.evidence.some(entry => entry.itemId === 'item-4'));
});

test('JSON escaping in long preferences cannot evict the latest refusal or exceed the context limit', () => {
  const context = buildChatContext('bjtu', { interests: Array(8).fill('"'.repeat(80)), goals: '"'.repeat(1000) }, [{ question: '不要再给建议。' + '"'.repeat(500), answer: '"'.repeat(1800), evidence: [{ itemId: 'current', version: 'v1' }] }], Array(8).fill('"'.repeat(100)));
  assert.ok(context.history.length <= 3500);
  const decoded = JSON.parse(context.history);
  assert.ok(decoded.exchanges.at(-1).user.startsWith('不要再给建议。'));
  assert.ok(context.evidence.some(entry => entry.itemId === 'current'));
});
