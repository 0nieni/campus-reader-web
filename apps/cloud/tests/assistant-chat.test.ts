import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureDb, identity } from './feature-fixture';
import { assistantChat } from '../src/assistant-chat';
import { aiService } from '../src/ai-service';
import { identify } from '../src/identity';
import type { AiConversation, AiChatTurn } from '@campus/contracts';
import { AppError } from '../src/errors';

function setup(complete?: Parameters<typeof aiService>[2], recommend: Parameters<typeof assistantChat>[3] = async () => ({ items: [], search: { state: 'idle' as const, message: '' }, coverage: '' })) {
  const f = fixtureDb(); let clock = Date.now(), calls = 0; const prompts: string[] = [];
  process.env.AI_CHAT_BASE_URL = 'https://api.deepseek.com'; process.env.AI_CHAT_MODEL = 'fixture-model'; process.env.AI_CHAT_API_KEY = 'fixture-key'; process.env.AI_EXECUTION_MODE = 'direct';
  const ai = aiService(f.db, f.repo, complete || (async (_c, guide, content) => { calls++; prompts.push(guide + content); return '需准备报名材料。[R1](https://www.bjtu.edu.cn/test)'; }), () => clock);
  const chat = assistantChat(f.db, f.repo, ai, recommend, () => clock);
  const call = (action: string, input: Record<string, unknown>, who = identity) => chat.handle(action, input, who);
  const create = async () => await call('ai.chat.create', { schoolId: 'bjtu', requestId: 'conversation-request-0001' }) as AiConversation;
  const send = async (id: string, req: string, question = '需要什么材料？') => await call('ai.chat.send', { conversationId: id, requestId: req, question, itemIds: ['notice'] }) as AiChatTurn;
  const finish = async (conversationId: string, turn: AiChatTurn) => { while (turn.state === 'ready') turn = await call('ai.chat.step', { conversationId, turnId: turn.id, step: turn.step }) as AiChatTurn; return turn; };
  return { ...f, call, create, send, finish, ai, prompts, calls: () => calls, advance: (ms: number) => { clock += ms; } };
}

test('chat supports followups with conversational guide, shared three-round quota and idempotency', async () => {
  const f = setup(), c = await f.create();
  assert.equal((await f.create()).id, c.id);
  const t = await f.send(c.id, 'first-request-00001');
  assert.equal(f.calls(), 0); assert.equal(t.state, 'ready');
  assert.equal((await f.send(c.id, 'first-request-00001')).id, t.id);
  const done = await f.finish(c.id, t); assert.equal(done.state, 'complete'); assert.match(done.result!, /报名材料/);
  await f.finish(c.id, await f.send(c.id, 'second-request-0001', '截止时间呢？'));
  await f.finish(c.id, await f.send(c.id, 'third-request-00001'));
  await assert.rejects(f.send(c.id, 'fourth-request-0001'), (e: any) => e.code === 'AI_QUOTA_EXHAUSTED');
  const quota = await f.ai.handle('ai.status', {}, identity) as any;
  assert.equal(quota.quota.used, 3); assert.equal(quota.quota.held, 0);
  assert.ok(f.prompts.some(p => p.includes('需要什么材料？') && p.includes('截止时间呢？')));
  assert.ok(!f.prompts.some(p => p.includes('七节结构保持完整')));
});

const sourceRevocations: Array<[string, Record<string, unknown>]> = [
  ['disabled', { enabled: false }], ['deleted', { deleted: true }],
  ['foreign owner', { scope: 'private', ownerOpenid: 'other-owner', aiProcessing: 'allow' }],
  ['foreign school', { scope: 'school', schoolIds: ['other'] }],
  ['own website foreign school', { scope: 'private', ownerOpenid: identity.dataOwnerId, importKind: 'website', schoolIds: ['other'], aiProcessing: 'allow' }],
];
for (const [reason, patch] of sourceRevocations) {
  test(`source ${reason} before a chat step blocks sending, redacts reads and allows cancellation`, async () => {
    const f = setup(), c = await f.create(), turn = await f.send(c.id, `revoked-before-${reason.replace(/ /g, '-')}`);
    Object.assign(f.rows('sources').get('source')!, patch);
    await assert.rejects(f.call('ai.chat.step', { conversationId: c.id, turnId: turn.id, step: 0 }), (e: any) => e.code === 'AI_POLICY_BLOCKED');
    assert.equal(f.calls(), 0);
    const view = await f.call('ai.chat.get', { conversationId: c.id }) as AiConversation;
    assert.equal(view.turns[0].result, null); assert.deepEqual(view.turns[0].references, []);
    const cancelled = await f.call('ai.chat.cancel', { conversationId: c.id, turnId: turn.id }) as AiChatTurn;
    assert.equal(cancelled.quotaHeld, false); assert.equal(cancelled.state, 'cancelled');
    assert.equal((await f.ai.handle('ai.status', {}, identity) as any).quota.held, 0);
  });
  test(`source ${reason} during a model call discards output and releases held quota`, async () => {
    let calls = 0;
    const f = setup(async () => { calls++; Object.assign(f.rows('sources').get('source')!, patch); return '不应采纳的结果 [R1](https://www.bjtu.edu.cn/test)'; });
    const c = await f.create(), turn = await f.send(c.id, `revoked-during-${reason.replace(/ /g, '-')}`);
    await assert.rejects(f.call('ai.chat.step', { conversationId: c.id, turnId: turn.id, step: 0 }), (e: any) => e.code === 'AI_POLICY_BLOCKED');
    const task = f.rows('web_ai_tasks').get(turn.taskId!)!;
    assert.equal(calls, 1); assert.equal(task.result, null); assert.deepEqual(task.notes, []);
    assert.equal(task.state, 'failed'); assert.equal(task.quotaHeld, false);
    const view = await f.call('ai.chat.get', { conversationId: c.id }) as AiConversation;
    assert.equal(view.turns[0].result, null); assert.deepEqual(view.turns[0].references, []);
    assert.equal((await f.ai.handle('ai.status', {}, identity) as any).quota.held, 0);
  });
}

test('legacy source without visibility metadata must still belong to the current public scope', async () => {
  const f = setup(), c = await f.create(), turn = await f.send(c.id, 'legacy-source-scope-01');
  f.repo.scope = async (schoolId, ownerId) => ({ schoolId, ownerId, publicSourceIds: [], privateSourceIds: [] });
  await assert.rejects(f.call('ai.chat.step', { conversationId: c.id, turnId: turn.id, step: 0 }), (e: any) => e.code === 'AI_POLICY_BLOCKED');
  assert.equal(f.calls(), 0);
});

test('secondary source revocation also stops the saved task', async () => {
  const f = setup();
  Object.assign(f.items.get('notice')!, { sourceIds: ['source', 'secondary'] });
  f.rows('sources').set('secondary', { _id: 'secondary', scope: 'school', schoolIds: ['bjtu'], aiProcessing: 'allow' });
  const c = await f.create(), turn = await f.send(c.id, 'secondary-policy-0001');
  f.rows('sources').get('secondary')!.enabled = false;
  await assert.rejects(f.call('ai.chat.step', { conversationId: c.id, turnId: turn.id, step: 0 }), (e: any) => e.code === 'AI_POLICY_BLOCKED');
  assert.equal(f.calls(), 0);
});

test('explicit own private mail and manual materials remain usable with explicit AI permission', async () => {
  for (const type of ['mail', 'manual']) {
    const f = setup();
    Object.assign(f.items.get('notice')!, { scope: 'private', ownerOpenid: identity.dataOwnerId, aiProcessing: 'allow', category: type });
    Object.assign(f.rows('sources').get('source')!, { scope: 'private', ownerOpenid: identity.dataOwnerId, aiProcessing: 'allow', key: `${type}-inbox` });
    const c = await f.create(), done = await f.finish(c.id, await f.send(c.id, `private-${type}-request-01`));
    assert.equal(done.state, 'complete'); assert.equal(f.calls(), 2);
  }
});

function mixedMaterials(f: ReturnType<typeof setup>, code = 'SOURCE_UNAVAILABLE') {
  f.items.set('unavailable', { ...f.items.get('notice')!, _id: 'unavailable', title: '只有标题的公告', contentText: '' });
  f.repo.material = async row => { if (row._id === 'unavailable') throw new AppError(code, '正文暂不可读'); return row; };
}
const mixedRecommendations: Parameters<typeof assistantChat>[3] = async () => ({ items: [{ id: 'unavailable', allowAi: true, readState: 'title_only' }, { id: 'notice', allowAi: true, readState: 'body' }] as any, search: { state: 'idle', message: '' }, coverage: '' });
test('automatic material selection skips unreadable fetches and cites only readable bodies', async () => {
  const f = setup(undefined, mixedRecommendations); mixedMaterials(f);
  const c = await f.create(), turn = await f.call('ai.chat.send', { conversationId: c.id, requestId: 'mixed-auto-request-01', question: '帮我概括公告' }) as AiChatTurn;
  assert.equal(turn.state, 'ready'); assert.deepEqual(turn.references.map(r => r.itemId), ['notice']);
  const done = await f.finish(c.id, turn); assert.equal(done.state, 'complete');
  assert.ok(f.prompts.every(prompt => !prompt.includes('只有标题的公告')));
});

for (const explicit of [false, true]) test(`${explicit ? 'explicit' : 'automatic'} missing materials give an idempotent no-model no-quota reply`, async () => {
  const f = setup(undefined, async () => ({ items: [{ id: 'unavailable', allowAi: true }] as any, search: { state: 'idle', message: '' }, coverage: '' })); mixedMaterials(f, 'NO_MATERIAL');
  const c = await f.create(), input = { conversationId: c.id, requestId: 'missing-body-request-01', question: '这篇说了什么', ...(explicit ? { itemIds: ['unavailable'] } : {}) };
  const turn = await f.call('ai.chat.send', input) as AiChatTurn;
  assert.equal(turn.state, 'complete'); assert.equal(turn.taskId, null); assert.equal(turn.quotaHeld, false); assert.deepEqual(turn.references, []);
  assert.match(turn.result!, /正文/); assert.deepEqual(await f.call('ai.chat.send', input), turn);
  assert.equal(f.calls(), 0); assert.equal(f.rows('web_ai_tasks').size, 0);
  assert.equal((await f.ai.handle('ai.status', {}, identity) as any).quota.held, 0);
});

test('automatic material selection never swallows source authorization failures', async () => {
  const f = setup(undefined, mixedRecommendations); mixedMaterials(f, 'AI_POLICY_BLOCKED');
  const c = await f.create();
  await assert.rejects(f.call('ai.chat.send', { conversationId: c.id, requestId: 'permission-auto-request-01', question: '概括公告' }), (e: any) => e.code === 'AI_POLICY_BLOCKED');
  assert.equal(f.calls(), 0); assert.equal(f.rows('web_ai_tasks').size, 0);
});

test('an explicit mixed selection with missing body safely asks for a revised selection without reserving quota', async () => {
  const f = setup(); mixedMaterials(f);
  const c = await f.create();
  const turn = await f.call('ai.chat.send', { conversationId: c.id, requestId: 'mixed-explicit-request-01', question: '比较这两篇', itemIds: ['notice', 'unavailable'] }) as AiChatTurn;
  assert.equal(turn.taskId, null); assert.deepEqual(turn.references, []); assert.match(turn.result!, /调整选择/);
  assert.equal(f.calls(), 0); assert.equal(f.rows('web_ai_tasks').size, 0);
});

test('automatic title-only materials without body or a fetch error remain a free no-model reply', async () => {
  const f = setup(undefined, mixedRecommendations); mixedMaterials(f);
  f.items.get('notice')!.contentText = '';
  f.repo.material = async row => row;
  const c = await f.create(), turn = await f.call('ai.chat.send', { conversationId: c.id, requestId: 'empty-auto-request-0001', question: '概括公告' }) as AiChatTurn;
  assert.equal(turn.taskId, null); assert.equal(turn.state, 'complete'); assert.deepEqual(turn.references, []);
  assert.equal(f.calls(), 0); assert.equal(f.rows('web_ai_tasks').size, 0);
});

test('source catalog bounds failures and item visibility failures are not mistaken for unreadable bodies', async () => {
  for (const code of ['SOURCE_LIMIT_EXCEEDED', 'NOT_FOUND']) {
    const f = setup(undefined, mixedRecommendations); mixedMaterials(f, code);
    const c = await f.create();
    await assert.rejects(f.call('ai.chat.send', { conversationId: c.id, requestId: 'bound-auto-request-0001', question: '概括公告' }), (e: any) => e.code === code);
    assert.equal(f.rows('web_ai_tasks').size, 0);
  }
});

test('conversation never leaks to other accounts and expires without extending on followup', async () => {
  const f = setup(), c = await f.create();
  const other = identify({ uid: 'other-account', isAnonymous: false }, { ownerUid: 'other-account' });
  await assert.rejects(f.call('ai.chat.get', { conversationId: c.id }, other), (e: any) => e.code === 'NOT_FOUND');
  await f.finish(c.id, await f.send(c.id, 'expiry-request-0001'));
  f.advance(86400001);
  await assert.rejects(f.call('ai.chat.get', { conversationId: c.id }), (e: any) => e.code === 'RESULT_EXPIRED');
  const stored = f.rows('web_ai_conversations').get(c.id)!; assert.equal(stored.purged, true); assert.equal(stored.turns, undefined);
});

test('clear revokes conversation and purges linked task bodies', async () => {
  const f = setup(), c = await f.create(), t = await f.send(c.id, 'clear-request-00001');
  await f.finish(c.id, t);
  await f.call('ai.chat.clear', { conversationId: c.id });
  await assert.rejects(f.call('ai.chat.get', { conversationId: c.id }));
  const row = f.rows('web_ai_tasks').get(t.taskId!)!; assert.equal(row.result, undefined); assert.equal(row.docs, undefined);
});

test('clear purges a concurrently completed turn from the latest locked conversation', async () => {
  const f = setup(), c = await f.create();
  const first = await f.finish(c.id, await f.send(c.id, 'clear-race-first-001'));
  let reached!: () => void, resume!: () => void;
  const reachedLoad = new Promise<void>(resolve => { reached = resolve; });
  const resumeLoad = new Promise<void>(resolve => { resume = resolve; });
  const selectedSchool = f.repo.selectedSchool.bind(f.repo);
  let pause = true;
  // Hold clear after it reads its initial conversation, while a second client
  // completes another turn before clear acquires the conversation row lock.
  f.repo.selectedSchool = async (...args) => {
    if (pause) { pause = false; reached(); await resumeLoad; }
    return selectedSchool(...args);
  };
  const clearing = f.call('ai.chat.clear', { conversationId: c.id });
  await reachedLoad;
  let second: AiChatTurn;
  try { second = await f.finish(c.id, await f.send(c.id, 'clear-race-second-01')); }
  finally { resume(); }
  await clearing;
  for (const taskId of [first.taskId!, second!.taskId!]) {
    const task = f.rows('web_ai_tasks').get(taskId)!;
    assert.equal(task.docs, undefined, `clear must remove body for ${taskId}`);
    assert.equal(task.result, undefined);
    assert.equal(task.chat, undefined);
    await assert.rejects(f.ai.handle('ai.task', { taskId }, identity), (error: any) => error.code === 'RESULT_EXPIRED');
  }
});

test('unknown calls retain quota and do not automatically replay', async () => {
  let calls = 0; const f = setup(async () => { calls++; throw Object.assign(new Error('timeout'), { code: 'MODEL_UNCERTAIN' }); });
  const c = await f.create(), t = await f.send(c.id, 'unknown-request-001');
  const uncertain = await f.finish(c.id, t); assert.equal(uncertain.state, 'uncertain');
  await f.call('ai.chat.step', { conversationId: c.id, turnId: t.id, step: 0 }); assert.equal(calls, 1);
  assert.equal((await f.ai.handle('ai.status', {}, identity) as any).quota.held, 1);
});

test('reading a terminal legacy task reconciles the chat lock without replaying the model', async () => {
  const f = setup(), c = await f.create(), turn = await f.send(c.id, 'legacy-finish-first-01');
  let task: any = turn;
  while (task.state === 'ready') task = await f.ai.handle('ai.step', { taskId: turn.taskId, step: task.step }, identity);
  assert.equal(f.rows('web_ai_conversations').get(c.id)!.pendingTurn, turn.id);
  const before = f.calls();
  const refreshed = await f.call('ai.chat.get', { conversationId: c.id }) as AiConversation;
  assert.equal(refreshed.turns[0].state, 'complete');
  assert.equal(f.rows('web_ai_conversations').get(c.id)!.pendingTurn, null);
  assert.equal(f.calls(), before);
  assert.equal((await f.send(c.id, 'legacy-finish-next-001')).state, 'ready');
});

test('school changes and revoked source policy stop subsequent steps and reads', async () => {
  const f = setup(), c = await f.create(), t = await f.send(c.id, 'scope-request-00001');
  await f.repo.selectSchool(identity.dataOwnerId, 'other');
  await assert.rejects(f.call('ai.chat.step', { conversationId: c.id, turnId: t.id, step: 0 }), (e: any) => e.code === 'STALE_SCOPE');
  await f.repo.selectSchool(identity.dataOwnerId, 'bjtu');
  f.rows('sources').get('source')!.aiProcessing = 'import_only';
  const view = await f.call('ai.chat.get', { conversationId: c.id }) as AiConversation;
  assert.equal(view.turns[0].result, null); assert.equal(view.turns[0].state, 'failed');
  assert.equal(f.calls(), 0);
});

test('revoked materials retain cancelled and uncertain recovery states while hiding evidence', async () => {
  let calls = 0;
  const f = setup(async () => { calls++; throw Object.assign(new Error('upstream timeout'), { code: 'MODEL_UNCERTAIN' }); });
  const c = await f.create(), turn = await f.send(c.id, 'revoked-recovery-0001');
  assert.equal((await f.finish(c.id, turn)).state, 'uncertain');
  f.rows('sources').get('source')!.aiProcessing = 'import_only';
  const view = await f.call('ai.chat.get', { conversationId: c.id }) as AiConversation;
  assert.equal(view.turns[0].state, 'uncertain');
  assert.equal(view.turns[0].quotaHeld, true);
  assert.equal(view.turns[0].result, null);
  assert.deepEqual(view.turns[0].references, []);
  const cancelled = await f.call('ai.chat.cancel', { conversationId: c.id, turnId: turn.id }) as AiChatTurn;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.quotaHeld, true);
  assert.equal(cancelled.result, null);
  assert.deepEqual(cancelled.references, []);
  const resolved = await f.call('ai.chat.resolve', { conversationId: c.id, turnId: turn.id, charged: false }) as AiChatTurn;
  assert.equal(resolved.state, 'cancelled');
  assert.equal(resolved.quotaHeld, false);
  assert.equal(resolved.result, null);
  assert.deepEqual(resolved.references, []);
  assert.equal(f.rows('web_ai_conversations').get(c.id)!.pendingTurn, null);
  assert.equal((await f.ai.handle('ai.status', {}, identity) as any).quota.held, 0);
  assert.equal(calls, 1);
});
