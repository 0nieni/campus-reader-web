import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiChatTurn, AiConversation } from '@campus/contracts';
import { fixtureDb, identity } from './feature-fixture';
import { assistantChat } from '../src/assistant-chat';
import { aiService } from '../src/ai-service';
import { memoryService } from '../src/assistant-memory';

function setup(now = Date.now, reply = '公告要求提交报名材料。[R1](https://www.bjtu.edu.cn/test)') {
  const f = fixtureDb(), prompts: string[] = []; let calls = 0;
  const ai = aiService(f.db, f.repo, async (_connection, _guide, content) => { calls++; prompts.push(content); return reply; }, now);
  const chat = assistantChat(f.db, f.repo, ai, async () => { throw new Error('memory commands must not recommend'); }, now, async () => { throw new Error('memory commands must not search'); });
  const call = (action: string, input: Record<string, unknown>) => chat.handle(action, input, identity);
  const create = async () => await call('ai.chat.create', { schoolId: 'bjtu', requestId: 'continuity-conversation-01' }) as AiConversation;
  const send = async (id: string, requestId: string, question: string, byok = false) => await call('ai.chat.send', { conversationId: id, requestId, question, itemIds: ['notice'], ...(byok ? { service: 'byok', provider: 'deepseek', model: 'deepseek-chat' } : {}) }) as AiChatTurn;
  const finish = async (id: string, turn: AiChatTurn) => { while (turn.state === 'ready') turn = await call('ai.chat.step', { conversationId: id, turnId: turn.id, step: turn.step, connection: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'fixture-key' } }) as AiChatTurn; return turn; };
  return { ...f, call, create, send, finish, prompts, calls: () => calls, memory: memoryService(f.db, f.repo, now), ai };
}

test('an explicit forget command works without material, model or quota and replay cannot delete a newly learned fact', async () => {
  const f = setup(); delete process.env.AI_CHAT_API_KEY;
  const memory = f.memory, at = Date.now() - 1000;
  await memory.apply(identity.dataOwnerId, 'bjtu', { requestId: 'seed-major-before-command', question: '我是计算机专业', proposals: [{ slot: 'major', text: '我是计算机专业', evidence: '我是计算机专业' }], generation: 0, observedAt: at });
  const c = await f.create(); f.items.clear();
  const done = await f.send(c.id, 'forget-major-request-01', '忘掉我的专业');
  assert.equal(done.state, 'complete'); assert.equal(done.taskId, null);
  assert.match(done.result!, /(?:删除|忘掉|忘记|移除)/);
  let state = await memory.get(identity.dataOwnerId, 'bjtu'); assert.equal(state.items.length, 0);
  await memory.apply(identity.dataOwnerId, 'bjtu', { requestId: 'seed-major-after-command', question: '我是数学专业', proposals: [{ slot: 'major', text: '我是数学专业', evidence: '我是数学专业' }], generation: state.generation, observedAt: Date.now() - 1 });
  await f.send(c.id, 'forget-major-request-01', '忘掉我的专业');
  state = await memory.get(identity.dataOwnerId, 'bjtu'); assert.equal(state.items[0]?.text, '我是数学专业');
  assert.equal(f.calls(), 0); assert.equal(f.rows('web_ai_accounts').size, 0);
});

test('natural goal cancellation removes only its matching goal and preserves manual goals', async () => {
  const f = setup();
  const row = f.rows('user_profiles').get(identity.dataOwnerId)!;
  row.aiAssistant = { bjtu: { preferences: { goals: '手填目标保留', interests: [], learningEnabled: false, version: 0 } } };
  for (const [index, text] of ['我准备考研', '我想参加编程竞赛'].entries()) {
    await f.memory.apply(identity.dataOwnerId, 'bjtu', { requestId: `seed-independent-goal-${index}`, question: text, proposals: [{ slot: 'goal', text, evidence: text }], generation: 0, observedAt: Date.now() - 1000 + index });
  }
  const c = await f.create(); const done = await f.send(c.id, 'cancel-research-goal-01', '我现在不准备考研了');
  assert.match(done.result!, /(?:删除|移除|忘记|忘掉|停止)/);
  const state = await f.memory.get(identity.dataOwnerId, 'bjtu');
  assert.deepEqual(state.items.filter(v => v.slot === 'goal').map(v => v.text), ['我想参加编程竞赛']);
  assert.equal(f.rows('user_profiles').get(identity.dataOwnerId)!.aiAssistant.bjtu.preferences.goals, '手填目标保留');
  assert.equal(f.calls(), 0);
});

test('a fourth completed BYOK exchange retains an earlier decision in the fifth turn summary without extra model calls', async () => {
  const f = setup(), c = await f.create();
  for (const [index, question] of ['我决定先整理蓝色项目介绍', '报名表有什么要求', '材料可以用电子版吗', '活动地点在哪'].entries()) {
    const done = await f.finish(c.id, await f.send(c.id, `summary-exchange-${index}-01`, question, true)); assert.equal(done.state, 'complete');
  }
  const pending = await f.send(c.id, 'summary-exchange-last-01', '之前决定先做的事情是什么', true);
  const stored = f.rows('web_ai_tasks').get(pending.taskId!)!;
  assert.ok(stored.chat.summary?.includes('蓝色项目介绍'), 'older decision must survive beyond three exchanges');
  assert.ok(stored.chat.summary.length <= 1200);
  const before = f.calls(); const done = await f.finish(c.id, pending); assert.equal(done.state, 'complete');
  assert.ok(f.prompts.at(-1)!.includes('蓝色项目介绍'));
  assert.equal(f.calls() - before, 2, 'only existing material batch and final answer, no summary call');
  assert.equal((await f.ai.handle('ai.status', {}, identity) as any).quota.used, 0);
});

test('revoking evidence after summary preparation stops before a new model call', async () => {
  const f = setup(), c = await f.create();
  for (let index = 0; index < 4; index++) await f.finish(c.id, await f.send(c.id, `revoked-summary-${index}-01`, `我决定准备第${index}份材料`, true));
  const pending = await f.send(c.id, 'revoked-summary-last-01', '接下来呢', true), before = f.calls();
  assert.ok(f.rows('web_ai_tasks').get(pending.taskId!)!.chat.summary);
  f.rows('sources').get('source')!.aiProcessing = 'import_only';
  await assert.rejects(f.call('ai.chat.step', { conversationId: c.id, turnId: pending.id, step: 0, connection: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'fixture-key' } }));
  assert.equal(f.calls(), before);
});

test('forgetting memory prevents old memory-bearing exchanges from resurfacing through the summary', async () => {
  const f = setup(), at = Date.now() - 1000;
  await f.memory.apply(identity.dataOwnerId, 'bjtu', { requestId: 'summary-major-before-forget', question: '我是计算机专业', proposals: [{ slot: 'major', text: '我是计算机专业', evidence: '我是计算机专业' }], generation: 0, observedAt: at });
  const c = await f.create();
  for (let index = 0; index < 4; index++) await f.finish(c.id, await f.send(c.id, `deleted-summary-${index}-01`, `我决定准备紫色方案第${index}步`, true));
  const command = await f.send(c.id, 'deleted-summary-command-01', '忘掉我的专业'); assert.equal(command.state, 'complete');
  const turn = await f.send(c.id, 'deleted-summary-next-01', '这个比赛需要什么材料', true);
  const task = f.rows('web_ai_tasks').get(turn.taskId!)!;
  assert.ok(!task.chat.summary?.includes('紫色方案'));
  assert.ok(!task.chat.history.includes('紫色方案'));
  assert.deepEqual(task.chat.memory.items, []);
});

test('summary payload has its own bounded validation before creating a usable task', async () => {
  const f = setup();
  await assert.rejects(f.ai.handle('ai.start', { schoolId: 'bjtu', itemIds: ['notice'], requestId: 'overlong-summary-task-01', service: 'byok', provider: 'deepseek', model: 'deepseek-chat', task: 'answer', question: '材料是什么', chat: { history: '', summary: '摘'.repeat(1201), expireAt: new Date(Date.now() + 60000).toISOString() } }, identity), (error: any) => error.code === 'VALIDATION_FAILED');
  assert.equal(f.calls(), 0);
});

test('expiry of a transitively mentioned goal fences a later batch and excludes the carrying exchange from new context', async () => {
  let clock = Date.now();
  const f = setup(() => clock, '按你的考研目标继续准备。[R1](https://www.bjtu.edu.cn/test)');
  const stamp = new Date(clock - 1000).toISOString();
  f.rows('user_profiles').get(identity.dataOwnerId)!.aiMemory = { bjtu: { enabled: true, version: 1, generation: 0, items: [
    { id: 'goal_a', slot: 'goal', text: '我准备考研', createdAt: stamp, updatedAt: stamp, expiresAt: new Date(clock + 3600000).toISOString() },
    { id: 'goal_b', slot: 'goal', text: '我准备实习', createdAt: stamp, updatedAt: stamp, expiresAt: new Date(clock + 86400000).toISOString() },
  ] } };
  const c = await f.create();
  await f.finish(c.id, await f.send(c.id, 'transitive-goal-first-01', '考研需要哪些材料', true));
  await f.finish(c.id, await f.send(c.id, 'transitive-goal-second-01', '实习需要哪些材料', true));
  const pending = await f.send(c.id, 'transitive-goal-third-01', '实习还有什么要准备', true);
  assert.deepEqual(f.rows('web_ai_tasks').get(pending.taskId!)!.chat.memory.items.map((v: any) => v.id), ['goal_b']);
  clock += 3600001; const before = f.calls();
  await assert.rejects(f.call('ai.chat.step', { conversationId: c.id, turnId: pending.id, step: 0, connection: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'fixture-key' } }), (error: any) => error.code === 'MATERIAL_CHANGED');
  assert.equal(f.calls(), before);
  await f.call('ai.chat.cancel', { conversationId: c.id, turnId: pending.id });
  const next = await f.send(c.id, 'transitive-goal-fourth-01', '实习下一步呢', true);
  const context = f.rows('web_ai_tasks').get(next.taskId!)!.chat;
  assert.ok(!context.history.includes('考研目标') && !context.summary?.includes('考研目标'));
});
