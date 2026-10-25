import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChatContext, type ContextExchange } from '../src/chat-context';
import { buildConversationSummary } from '../src/conversation-summary';

const exchange = (question: string, answer: string, itemId: string): ContextExchange => ({ question, answer, evidence: [{ itemId, version: 'v1' }] });

test('an early decision survives beyond the recent three turns without duplicating recent dialogue', () => {
  const exchanges = [exchange('我决定先准备实习。', '先整理已有作品。', 'decision'), ...Array.from({ length: 3 }, (_, index) => exchange(`近期问题${index}`, `近期回答${index}`, `recent-${index}`))];
  const summary = buildConversationSummary(exchanges.slice(0, -3));
  const context = buildChatContext('bjtu', undefined, exchanges.slice(-3), [], undefined, summary);
  assert.ok(context.summary.includes('我决定先准备实习。'));
  assert.ok(!context.summary.includes('近期问题'));
  assert.ok(!context.history.includes('我决定先准备实习。'));
  assert.deepEqual(summary.evidence, [{ itemId: 'decision', version: 'v1' }]);
});

test('empty or unfinished exchanges contribute neither text nor evidence', () => {
  assert.deepEqual(buildConversationSummary([]), { text: '', evidence: [], memoryDependencies: [] });
  const result = buildConversationSummary([exchange('还没完成的问题', '', 'pending'), exchange(' ', '孤立答案', 'empty-question'), exchange('问题', ' \n ', 'empty-answer')]);
  assert.deepEqual(result, { text: '', evidence: [], memoryDependencies: [] });
});

test('decisions and unfinished tasks outrank incidental dialogue under the summary budget', () => {
  const result = buildConversationSummary([
    exchange('我决定报名编程赛，还没准备报名表。', '待办是核对报名材料。', 'decision'),
    ...Array.from({ length: 12 }, (_, index) => exchange(`随便聊聊第${index}次`, '普通聊天内容。'.repeat(80), `incidental-${index}`)),
  ]);
  assert.ok(result.text.includes('我决定报名编程赛，还没准备报名表。'));
  assert.ok(result.text.includes('待办是核对报名材料。'));
  assert.ok(result.text.length <= 1200);
  assert.ok(result.evidence.some(entry => entry.itemId === 'decision'));
  assert.ok(result.evidence.length < 13);
});

test('unfinished work stated in an answer outranks later incidental dialogue', () => {
  const result = buildConversationSummary([
    exchange('这些材料怎么样？' + '补充描述。'.repeat(25), '尚未完成的是核对报名表。' + '材料细节。'.repeat(90), 'unfinished'),
    ...Array.from({ length: 12 }, (_, index) => exchange(`普通问题${index}` + '闲聊主题。'.repeat(25), '普通闲聊。'.repeat(90), `incidental-${index}`)),
  ]);
  assert.ok(result.text.includes('尚未完成的是核对报名表。'));
  assert.ok(result.evidence.some(entry => entry.itemId === 'unfinished'));
});

test('newer corrections appear before superseded decisions and remain verbatim', () => {
  const old = exchange('我决定考研。', '可以先整理考试信息。', 'old');
  const corrected = exchange('更正，我现在不准备考研了，改为准备实习。', '接下来先整理实习作品。', 'corrected');
  const result = buildConversationSummary([old, corrected]);
  assert.ok(result.text.includes(corrected.question));
  assert.ok(result.text.includes(corrected.answer));
  assert.ok(result.text.indexOf(corrected.question) < result.text.indexOf(old.question));
  assert.ok(!result.text.includes('已取得实习资格'));
});

test('the latest user correction wins ordering even when an older assistant also uses correction words', () => {
  const result = buildConversationSummary([
    exchange('更正，我先考研。', '更正后的目标是考研。', 'older-correction'),
    exchange('更正，我改为准备实习。', '先核对作品。', 'latest-correction'),
  ]);
  assert.ok(result.text.indexOf('更正，我改为准备实习。') < result.text.indexOf('更正，我先考研。'));
});

test('a decision after lengthy incidental sentences survives as a verbatim excerpt', () => {
  const original = exchange('这只是闲聊。'.repeat(100) + '我决定先准备实习。', '尚未完成作品材料。', 'late-decision');
  const result = buildConversationSummary([original]);
  assert.ok(result.text.includes('我决定先准备实习。'));
  assert.match(result.text, /摘录已缩短/);
  assert.ok(!result.text.includes('已完成作品材料'));
});

test('overlong original excerpts are explicitly shortened within the 1200 character budget', () => {
  const original = exchange('我决定先准备作品集。' + '问题细节。'.repeat(1000), '尚未完成的是材料核对。' + '回答细节。'.repeat(1000), 'long');
  const result = buildConversationSummary([original]);
  assert.ok(result.text.length <= 1200);
  assert.ok(result.text.includes('我决定先准备作品集。'));
  assert.ok(result.text.includes('尚未完成的是材料核对。'));
  assert.match(result.text, /摘录已缩短/);
  assert.deepEqual(result.evidence, [{ itemId: 'long', version: 'v1' }]);
});

test('summary dependencies belong only to selected excerpts and retain different source versions', () => {
  const result = buildConversationSummary([
    ...Array.from({ length: 10 }, (_, index) => exchange(`旧闲聊${index}`, '闲聊。'.repeat(120), `excluded-${index}`)),
    { question: '我决定准备实习。', answer: '尚未完成作品。', evidence: [{ itemId: 'shared', version: 'v1' }, { itemId: 'shared', version: 'v2' }, { itemId: 'shared', version: 'v2' }] },
  ]);
  assert.ok(result.evidence.some(entry => entry.itemId === 'shared' && entry.version === 'v1'));
  assert.equal(result.evidence.filter(entry => entry.itemId === 'shared' && entry.version === 'v2').length, 1);
  assert.ok(!result.evidence.some(entry => entry.itemId === 'excluded-0'));
  for (const dependency of result.evidence) {
    if (dependency.itemId.startsWith('excluded-')) assert.ok(result.text.includes(`旧闲聊${dependency.itemId.slice('excluded-'.length)}`));
  }
});

test('summary carries transitive memory dependencies and preserves different text for the same id', () => {
  const result = buildConversationSummary([
    { ...exchange('我决定先考研。', '先核对材料。', 'first'), memoryDependencies: [{ id: 'goalA', text: '准备考研' }] },
    { ...exchange('更正，先准备实习。', '继续整理作品。', 'second'), memoryDependencies: [{ id: 'goalA', text: '准备考研' }, { id: 'goalB', text: '准备实习' }, { id: 'goalA', text: '准备保研' }] },
  ]);
  assert.deepEqual(result.memoryDependencies, [{ id: 'goalA', text: '准备考研' }, { id: 'goalB', text: '准备实习' }, { id: 'goalA', text: '准备保研' }]);
});

test('unselected and unfinished summary exchanges cannot retain memory dependencies', () => {
  const result = buildConversationSummary([
    ...Array.from({ length: 10 }, (_, index) => ({ ...exchange(`旧闲聊${index}`, '闲聊。'.repeat(120), `old-${index}`), memoryDependencies: [{ id: `goal-${index}`, text: '闲聊目标' }] })),
    { ...exchange('未完成', '', 'pending'), memoryDependencies: [{ id: 'pending', text: '尚未完成的目标' }] },
    { ...exchange('我决定准备实习。', '尚未完成作品。', 'current'), memoryDependencies: [{ id: 'current', text: '准备实习' }] },
  ]);
  assert.ok(result.memoryDependencies.some(entry => entry.id === 'current'));
  assert.ok(!result.memoryDependencies.some(entry => entry.id === 'goal-0' || entry.id === 'pending'));
  for (const dependency of result.memoryDependencies) {
    if (dependency.id.startsWith('goal-')) assert.ok(result.text.includes(`旧闲聊${dependency.id.slice('goal-'.length)}`));
  }
  assert.deepEqual(buildConversationSummary([]).memoryDependencies, []);
});
