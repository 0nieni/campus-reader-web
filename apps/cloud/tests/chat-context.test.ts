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

test('older summary is separate from recent history and retains exact source versions', () => {
  const context = buildChatContext('bjtu', undefined, [{ question: '接下来呢？', answer: '先核对通知。', evidence: [{ itemId: 'shared', version: 'v2' }] }], [], undefined, {
    text: '问：我决定先准备实习。\n答：先整理作品。',
    evidence: [{ itemId: 'old', version: 'v1' }, { itemId: 'shared', version: 'v1' }, { itemId: 'shared', version: 'v2' }],
  });
  assert.equal(context.summary, '问：我决定先准备实习。\n答：先整理作品。');
  assert.ok(!context.history.includes('我决定先准备实习'));
  assert.ok(context.history.length <= 3500);
  assert.deepEqual(context.evidence, [{ itemId: 'shared', version: 'v2' }, { itemId: 'old', version: 'v1' }, { itemId: 'shared', version: 'v1' }]);
});

test('omitted or empty summary cannot retain unrepresented evidence', () => {
  assert.equal(buildChatContext('bjtu', undefined, [], []).summary, '');
  const context = buildChatContext('bjtu', undefined, [], [], undefined, { text: '  ', evidence: [{ itemId: 'unused', version: 'v1' }] });
  assert.equal(context.summary, '');
  assert.deepEqual(context.evidence, []);
});

test('memory dependency versions merge from retained history and summary without discarding earlier text', () => {
  const context = buildChatContext('bjtu', undefined, [{
    question: '接下来呢？', answer: '继续核对材料。', evidence: [],
    memoryDependencies: [{ id: 'goalA', text: '准备考研' }, { id: 'goalB', text: '准备实习' }],
  }], [], undefined, {
    text: '问：更正目标。\n答：核对目标。', evidence: [],
    memoryDependencies: [{ id: 'goalA', text: '准备考研' }, { id: 'goalA', text: '准备保研' }],
  });
  assert.deepEqual(context.memoryDependencies, [{ id: 'goalA', text: '准备考研' }, { id: 'goalB', text: '准备实习' }, { id: 'goalA', text: '准备保研' }]);
});

test('history budget eviction removes only excluded exchanges memory dependencies', () => {
  const exchanges = Array.from({ length: 5 }, (_, index) => ({
    question: `第${index}问` + '问'.repeat(450), answer: `第${index}答` + '答'.repeat(1200), evidence: [],
    memoryDependencies: index === 4 ? [{ id: 'goalB', text: '准备实习' }, { id: 'goalA', text: '准备考研' }] : [{ id: `excluded-${index}`, text: '未收录的目标' }],
  }));
  const context = buildChatContext('bjtu', { goals: '背景'.repeat(300) }, exchanges, Array(8).fill('标题'.repeat(40)));
  const retained = JSON.parse(context.history).exchanges;
  assert.equal(retained.length, 1);
  assert.ok(retained[0].user.startsWith('第4问'));
  assert.deepEqual(context.memoryDependencies, [{ id: 'goalB', text: '准备实习' }, { id: 'goalA', text: '准备考研' }]);
});

test('empty summaries and legacy exchanges cannot introduce memory dependencies', () => {
  const context = buildChatContext('bjtu', undefined, [{ question: '问题', answer: '回答', evidence: [] }], [], undefined, {
    text: '  ', evidence: [], memoryDependencies: [{ id: 'unused', text: '旧目标' }],
  });
  assert.deepEqual(context.memoryDependencies, []);
});
