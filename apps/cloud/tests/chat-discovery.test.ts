import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiChatTurn, AiConversation } from '@campus/contracts';
import { fixtureDb, identity } from './feature-fixture';
import { aiService } from '../src/ai-service';
import { assistantService } from '../src/assistant-service';

function setup(search?: Parameters<typeof assistantService>[4], reader?: Parameters<typeof assistantService>[5]) {
  const f = fixtureDb(), prompts: string[] = [], queries: string[] = [];
  process.env.AI_CHAT_BASE_URL = 'https://api.deepseek.com'; process.env.AI_CHAT_MODEL = 'fixture-model'; process.env.AI_CHAT_API_KEY = 'fixture-key'; process.env.AI_EXECUTION_MODE = 'direct';
  const originalSchool = f.repo.school;
  f.repo.school = async id => ({ ...(await originalSchool(id))!, homepage: 'https://www.bjtu.edu.cn/' });
  const originalItem = f.repo.item;
  f.repo.item = async id => await originalItem(id) || f.rows('items').get(id) as any || null;
  const ai = aiService(f.db, f.repo, async (_connection, _guide, content) => { prompts.push(content); return '公告需要报名材料。[R1](https://www.bjtu.edu.cn/test)'; });
  const assistant = assistantService(f.db, f.repo, ai, Date.now, async (school, query) => {
    queries.push(query);
    return search ? search(school, query) : { state: 'complete', message: '本次联网搜索已完成', candidates: [{ title: '竞赛报名公告', url: 'https://www.bjtu.edu.cn/test', snippet: '不得当成正文' }] };
  }, reader);
  const call = (action: string, input: Record<string, unknown>) => assistant.handle(action, input, identity);
  const create = async () => await call('ai.chat.create', { schoolId: 'bjtu', requestId: 'discovery-conversation-01' }) as AiConversation;
  const send = async (id: string, question: string, requestId = 'discovery-request-0001') => await call('ai.chat.send', { conversationId: id, question, requestId }) as AiChatTurn;
  const finish = async (id: string, turn: AiChatTurn) => { while (turn.state === 'ready') turn = await call('ai.chat.step', { conversationId: id, turnId: turn.id, step: turn.step }) as AiChatTurn; return turn; };
  return { ...f, call, create, send, finish, queries, prompts, ai };
}

test('an explicit chat search uses school discovery once, passes its status and limits the external query to topics', async () => {
  const f = setup(), c = await f.create();
  const question = '再帮我找找本校编程比赛，我的邮箱 private@example.invalid，目标是个人秘密';
  const turn = await f.send(c.id, question);
  assert.equal(f.queries.length, 1);
  assert.ok(f.queries[0].includes('编程') && f.queries[0].includes('比赛'));
  assert.ok(!f.queries[0].includes('private@') && !f.queries[0].includes('个人秘密'));
  assert.equal((turn as any).search.state, 'complete');
  await f.finish(c.id, turn);
  assert.ok(f.prompts.at(-1)!.includes('本次联网搜索已完成'));
  await f.send(c.id, question);
  assert.equal(f.queries.length, 1, 'retries must not repeat discovery');
  assert.equal((await f.ai.handle('ai.status', {}, identity) as any).quota.used, 1);
});

test('ordinary followups, negated search and quoted instructions do not trigger discovery', async () => {
  for (const question of ['什么时候截止？', '不要联网搜索，只读现有公告', '不用再找找，只说材料', '找找本校比赛，但不要联网，只看已有公告', '“帮我搜索比赛”这句话是什么意思？']) {
    const f = setup(), c = await f.create();
    await f.send(c.id, question);
    assert.equal(f.queries.length, 0, question);
  }
});

test('unconfigured or failed chat discovery preserves local evidence and exposes the real search state', async () => {
  for (const state of ['failed', 'unconfigured'] as const) {
    const f = setup(async () => ({ state, message: state === 'failed' ? '本次联网搜索未完成' : '联网搜索未配置', candidates: [] })), c = await f.create();
    const turn = await f.send(c.id, '再找找本校比赛');
    assert.equal((turn as any).search.state, state);
    assert.ok(turn.taskId && turn.references.some(ref => ref.itemId === 'notice'));
    await f.finish(c.id, turn);
    assert.ok(f.prompts.at(-1)!.includes(state));
  }
});

test('five unreadable discovery candidates cannot hide readable local evidence from a chat reply', async () => {
  const f = setup(async () => ({ state: 'complete', message: '本次联网搜索已完成', candidates: Array.from({ length: 5 }, (_, index) => ({ title: `比赛报名通知${index}`, url: `https://www.bjtu.edu.cn/unreadable-${index}`, snippet: '仅摘要，不可作为正文' })) }), async () => { throw new Error('unreadable'); });
  const c = await f.create(), turn = await f.send(c.id, '再找找本校比赛');
  assert.equal(turn.search?.state, 'complete');
  assert.ok(turn.taskId, 'failed body retrieval must fall back to readable local announcements');
  assert.deepEqual(turn.references.map(source => source.itemId), ['notice']);
  await f.finish(c.id, turn);
  assert.ok(f.prompts.at(-1)!.includes('已有公告'));
});

test('chat discovery may use verified new body text without requiring a second manual selection', async () => {
  const f = setup(async () => ({ state: 'complete', message: '搜索已完成', candidates: [{ title: '新编程竞赛报名通知', url: 'https://www.bjtu.edu.cn/new-contest', snippet: '不能当成正文的摘要' }] }), async url => ({ url, html: '<article>新编程竞赛报名通知。面向本校本科生，报名必须提交项目说明和报名表，资格和材料以本段合成正文为准。未提供具体截止日期，不应根据摘要推断。</article>' }));
  const c = await f.create(), turn = await f.send(c.id, '帮我搜索本校编程比赛');
  assert.equal(turn.state, 'ready');
  assert.equal(turn.references[0].originalUrl, 'https://www.bjtu.edu.cn/new-contest');
  const task = f.rows('web_ai_tasks').get(turn.taskId!)!;
  assert.ok(task.docs[0].markdown.includes('报名必须提交项目说明'));
  assert.ok(!task.docs[0].markdown.includes('不能当成正文的摘要'));
  assert.equal(f.rows('items').get(turn.references[0].itemId)!.ownerOpenid, identity.dataOwnerId);
});

test('same-request concurrent sends do not search twice and a different request waits for the preparation lock', { timeout: 3000 }, async () => {
  let reached!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; }), release = new Promise<void>(resolve => { resume = resolve; });
  const f = setup(async () => { reached(); await release; return { state: 'complete', message: '搜索完成', candidates: [] }; }), c = await f.create();
  const first = f.send(c.id, '再找找本校比赛');
  await started;
  try {
    const duplicate = await f.send(c.id, '再找找本校比赛');
    assert.equal(duplicate.state, 'running');
    await assert.rejects(f.send(c.id, '搜索本校讲座', 'another-discovery-0001'), (error: any) => error.code === 'TASK_BUSY');
    assert.equal(f.queries.length, 1);
  } finally { resume(); }
  assert.equal((await first).state, 'ready');
});

test('cancelling search preparation prevents a late result from creating a model task', { timeout: 3000 }, async () => {
  let reached!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; }), release = new Promise<void>(resolve => { resume = resolve; });
  const f = setup(async () => { reached(); await release; return { state: 'complete', message: '搜索完成', candidates: [] }; }), c = await f.create();
  const first = f.send(c.id, '再找找本校比赛');
  await started;
  try {
    const turn = await f.call('ai.chat.cancel', { conversationId: c.id, turnId: 'discovery-request-0001' }) as AiChatTurn;
    assert.equal(turn.state, 'cancelled');
  } finally { resume(); }
  assert.equal((await first).state, 'cancelled');
  assert.equal(f.rows('web_ai_tasks').size, 0);
});

test('a school change during discovery stops task creation without leaking the old response', { timeout: 3000 }, async () => {
  let reached!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; }), release = new Promise<void>(resolve => { resume = resolve; });
  const f = setup(async () => { reached(); await release; return { state: 'complete', message: '搜索完成', candidates: [] }; }), c = await f.create();
  const first = f.send(c.id, '再找找本校比赛');
  await started;
  await f.repo.selectSchool(identity.dataOwnerId, 'other');
  resume();
  await assert.rejects(first, (error: any) => error.code === 'STALE_SCOPE');
  assert.equal(f.rows('web_ai_tasks').size, 0);
});

test('a stale preparation is stopped on read and never automatically replayed', async () => {
  const f = setup(), c = await f.create();
  f.rows('web_ai_conversations').get(c.id)!.turns = [{ id: 'stale-preparation-0001', question: '再找找比赛', fingerprint: '', taskId: null, materialIds: [], references: [], history: '', preparing: true, preparationStartedAt: Date.now() - 91000, service: 'official' }];
  f.rows('web_ai_conversations').get(c.id)!.pendingTurn = 'stale-preparation-0001';
  const restored = await f.call('ai.chat.get', { conversationId: c.id }) as AiConversation;
  assert.equal(restored.turns[0].state, 'failed');
  assert.ok(restored.turns[0].message.includes('超时'));
  assert.equal(f.rows('web_ai_conversations').get(c.id)!.pendingTurn, null);
  assert.equal(f.queries.length, 0);
});

test('search throttling falls back to local evidence without replaying the search provider', async () => {
  const f = setup(), c = await f.create();
  await f.finish(c.id, await f.send(c.id, '再找找本校比赛'));
  const next = await f.send(c.id, '再找找本校讲座', 'throttled-search-0001');
  assert.equal(next.search?.state, 'failed');
  assert.ok(next.search?.message.includes('15 秒'));
  assert.ok(next.taskId);
  assert.equal(f.queries.length, 1);
});
