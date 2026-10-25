import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiChatTurn, AiConversation, AiMemoryState } from '@campus/contracts';
import { fixtureDb, identity } from './feature-fixture';
import { aiService } from '../src/ai-service';
import { assistantService } from '../src/assistant-service';

const question = '我想长期积累项目经验，这个比赛需要准备什么？';
const fact = '我想长期积累项目经验';
const marker = `<!--campus-memory ${JSON.stringify({ items: [{ slot: 'goal', text: fact, evidence: fact }] })} -->`;
function setup(reply = '报名要交报名表。[R1](https://www.bjtu.edu.cn/test)\n' + marker, now = Date.now) {
  const f = fixtureDb(), prompts: string[] = []; let calls = 0;
  process.env.AI_CHAT_BASE_URL = 'https://api.deepseek.com'; process.env.AI_CHAT_MODEL = 'fixture-model'; process.env.AI_CHAT_API_KEY = 'fixture-key'; process.env.AI_EXECUTION_MODE = 'direct';
  const ai = aiService(f.db, f.repo, async (_connection, _guide, content) => { calls++; prompts.push(content); return reply; }, now);
  const assistant = assistantService(f.db, f.repo, ai, now);
  const call = (action: string, input: Record<string, unknown>) => assistant.handle(action, input, identity);
  const create = async (requestId = 'auto-memory-conversation-01') => await call('ai.chat.create', { schoolId: 'bjtu', requestId }) as AiConversation;
  const send = async (conversationId: string, requestId = 'auto-memory-request-001', text = question) => await call('ai.chat.send', { conversationId, question: text, requestId, itemIds: ['notice'] }) as AiChatTurn;
  const finish = async (conversationId: string, turn: AiChatTurn) => { while (turn.state === 'ready') turn = await call('ai.chat.step', { conversationId, turnId: turn.id, step: turn.step }) as AiChatTurn; return turn; };
  const memory = async () => await call('ai.memory.get', { schoolId: 'bjtu' }) as AiMemoryState;
  return { ...f, ai, call, create, send, finish, memory, prompts, calls: () => calls };
}

test('a successful reply automatically saves necessary user facts and supplies them to a new conversation', async () => {
  const f = setup(), c = await f.create(), done = await f.finish(c.id, await f.send(c.id));
  assert.equal(done.state, 'complete');
  assert.ok(!done.result!.includes('campus-memory') && !done.result!.includes('"items"'));
  const stored = await f.memory();
  assert.equal(stored.items.find(item => item.slot === 'goal')?.text, fact);
  assert.equal((await f.ai.handle('ai.status', {}, identity) as any).quota.used, 1);
  const previousCalls = f.calls();
  await f.call('ai.chat.get', { conversationId: c.id });
  assert.equal(f.calls(), previousCalls, 'memory reconciliation must never call the model');
  const next = await f.create('auto-memory-new-conversation-01');
  await f.finish(next.id, await f.send(next.id, 'auto-memory-next-turn-001', '最近有什么适合我的公告？'));
  assert.ok(f.prompts.at(-1)!.includes(fact));
  assert.ok(f.prompts.at(-1)!.includes('自动记忆'));
});

test('a final answer rejected for invalid citations never saves its proposed memory', async () => {
  const f = setup('这是没有引用的答案。' + marker), c = await f.create();
  const done = await f.finish(c.id, await f.send(c.id));
  assert.equal(done.state, 'failed');
  assert.deepEqual((await f.memory()).items, []);
  assert.equal((await f.ai.handle('ai.status', {}, identity) as any).quota.used, 0);
});

test('forgetting before a pending batch invalidates its old memory context without a model call', async () => {
  const f = setup(), c = await f.create();
  await f.finish(c.id, await f.send(c.id));
  const pending = await f.send(c.id, 'auto-memory-pending-001', '接下来要做什么？');
  const state = await f.memory();
  await f.call('ai.memory.forget', { schoolId: 'bjtu', id: 'goal', version: state.version });
  const before = f.calls();
  await assert.rejects(f.call('ai.chat.step', { conversationId: c.id, turnId: pending.id, step: 0 }), (error: any) => error.code === 'MATERIAL_CHANGED');
  assert.equal(f.calls(), before);
  assert.deepEqual((await f.memory()).items, []);
});

test('disabled automatic memory strips proposed metadata but neither uses nor saves it', async () => {
  const f = setup(), before = await f.memory();
  await f.call('ai.memory.configure', { schoolId: 'bjtu', enabled: false, version: before.version });
  const c = await f.create(), done = await f.finish(c.id, await f.send(c.id));
  assert.equal(done.state, 'complete');
  assert.ok(!done.result!.includes('campus-memory'));
  assert.deepEqual((await f.memory()).items, []);
});

test('a remembered stage expiring between send and step is no longer sent to the model', async () => {
  let clock = Date.now();
  const f = setup(undefined, () => clock);
  const stamp = new Date(clock - 1000).toISOString();
  f.rows('user_profiles').get(identity.dataOwnerId)!.aiMemory = { bjtu: { enabled: true, generation: 0, version: 1, items: [{ id: 'progress', slot: 'progress', text: '我已经提交报名材料', createdAt: stamp, updatedAt: stamp, expiresAt: new Date(clock + 1000).toISOString() }], processedRequests: [] } };
  const c = await f.create(), turn = await f.send(c.id);
  clock += 2000;
  await assert.rejects(f.call('ai.chat.step', { conversationId: c.id, turnId: turn.id, step: 0 }), (error: any) => error.code === 'MATERIAL_CHANGED');
  assert.equal(f.calls(), 0);
});

test('a memory persistence failure cannot hide an already successful charged answer and can reconcile on read', async () => {
  const f = setup(), start = f.db.startTransaction.bind(f.db);
  f.db.startTransaction = async () => {
    const tx = await start(), collection = tx.collection.bind(tx);
    tx.collection = ((name: string) => {
      const c = collection(name), doc = c.doc.bind(c);
      if (name === 'user_profiles') c.doc = ((id: string) => {
        const ref = doc(id), update = ref.update.bind(ref);
        ref.update = (async (value: any) => { if (value.aiMemory) throw new Error('fixture memory write unavailable'); return update(value); }) as typeof ref.update;
        return ref;
      }) as typeof c.doc;
      return c;
    }) as typeof tx.collection;
    return tx;
  };
  const c = await f.create(), done = await f.finish(c.id, await f.send(c.id));
  assert.equal(done.state, 'complete');
  assert.ok(done.result?.includes('报名表'));
  assert.ok((done as any).memoryMessage.includes('记忆暂未更新'));
  assert.equal((await f.ai.handle('ai.status', {}, identity) as any).quota.used, 1);
  const before = f.calls(); f.db.startTransaction = start;
  await f.call('ai.chat.get', { conversationId: c.id });
  assert.equal(f.calls(), before);
  assert.equal((await f.memory()).items[0].text, fact);
});

test('failure of the optional candidate read cannot hide a successfully completed reply', async () => {
  const f = setup(), handle = f.ai.handle.bind(f.ai), collection = f.db.collection.bind(f.db);
  let failNextRead = false;
  f.ai.handle = async (...args) => {
    const result = await handle(...args);
    if (args[0] === 'ai.task' && (result as any)?.state === 'complete') failNextRead = true;
    return result;
  };
  f.db.collection = ((name: string) => {
    const c = collection(name), get = c.get.bind(c);
    c.get = (async () => {
      if (name === 'web_ai_tasks' && failNextRead) { failNextRead = false; throw new Error('optional candidate read failure'); }
      return get();
    }) as typeof c.get;
    return c;
  }) as typeof f.db.collection;
  const c = await f.create(), done = await f.finish(c.id, await f.send(c.id));
  assert.equal(done.state, 'complete');
  assert.ok(done.result?.includes('报名表'));
  assert.ok(done.memoryMessage?.includes('记忆暂未更新'));
  assert.equal((await handle('ai.status', {}, identity) as any).quota.used, 1);
});
