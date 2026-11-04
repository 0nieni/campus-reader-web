import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NetlifyDB } from '@netlify/database-dev';
import { getDatabase } from '@netlify/database';
import type { AiChatTurn, AiConversation, GatewayResult, ReadingTask } from '@campus/contracts';
import { postgresStorage, type SqlPool } from '../src/postgres-storage';
import { postgresRepository } from '../src/postgres-repository';
import { createGateway } from '../src/gateway';
import { aiService } from '../src/ai-service';
import { assistantService } from '../src/assistant-service';

test('real local SQL assistant conversations reuse quota, isolate owners and recover held calls', async t => {
  const server = new NetlifyDB({ logger() {} });
  const connectionString = await server.start();
  const pool = getDatabase({ connectionString }).pool;
  // Local PGlite runs one SQL process. Serialize driver connections; the
  // concurrent application requests below are not a hosted contention/load test.
  (pool as unknown as { options: { max: number } }).options.max = 1;
  const sql = pool as unknown as SqlPool, db = postgresStorage(sql), repo = postgresRepository(sql);
  let clock = Date.now(), calls = 0, uncertain = false;
  const now = () => clock;
  process.env.AI_CHAT_BASE_URL = 'https://api.deepseek.com'; process.env.AI_CHAT_MODEL = 'fixture-model';
  process.env.AI_CHAT_API_KEY = 'fixture-key'; process.env.AI_EXECUTION_MODE = 'direct';
  process.env.AI_DAILY_LIMIT = '3';
  const ai = aiService(db, repo, async () => {
    calls++;
    if (uncertain) throw Object.assign(new Error('injected timeout'), { code: 'MODEL_UNCERTAIN' });
    return '报名材料见 [R1](https://www.bjtu.edu.cn/test)';
  }, now);
  const assistant = assistantService(db, repo, ai, now);
  const asOwner = (owner: string) => {
    const actor = { uid: owner, isAnonymous: false };
    const gateway = createGateway(repo, { ownerUid: owner, dataOwnerId: owner }, now, {
      ai: { handle: (action, input, identity) => assistant.supports(action) ? assistant.handle(action, input, identity) : ai.handle(action, input, identity) },
    });
    return (action: string, input: Record<string, unknown> = {}) => gateway({ action, input }, actor);
  };
  const call = asOwner('sql-chat-owner'), other = asOwner('sql-chat-other');
  function data<T>(result: GatewayResult<unknown>): T { assert.ok(result.ok, JSON.stringify(result)); return result.data as T; }
  const quota = async () => data<any>(await call('ai.status')).quota;
  const create = async (requestId: string, request = call) => data<AiConversation>(await request('ai.chat.create', { schoolId: 'bjtu', requestId }));
  const inputFor = (conversationId: string, requestId: string) => ({ conversationId, requestId, question: '需要哪些报名材料？', itemIds: ['sql-chat-notice'] });
  const finish = async (conversationId: string, turn: AiChatTurn) => {
    while (turn.state === 'ready') turn = data<AiChatTurn>(await call('ai.chat.step', { conversationId, turnId: turn.id, step: turn.step }));
    return turn;
  };
  const winners: Array<{ conversation: AiConversation; turn: AiChatTurn; input: ReturnType<typeof inputFor> }> = [];
  let legacy: ReadingTask, replacement: { conversation: AiConversation; turn: AiChatTurn };
  try {
    await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations', import.meta.url)));
    const constraint = await sql.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='campus_documents_collection_check'");
    assert.match(constraint.rows[0].definition, /web_ai_conversations/);
    await db.collection('sources').doc('sql-chat-source').set({ scope: 'school', schoolIds: ['bjtu'], enabled: true, aiProcessing: 'allow' });
    await db.collection('items').doc('sql-chat-notice').set({ title: 'SQL 报名材料', contentText: '请提交报名材料。', sourceId: 'sql-chat-source', scope: 'school', schoolIds: ['bjtu'], status: 'published', publishedAt: new Date(clock).toISOString(), originalUrl: 'https://www.bjtu.edu.cn/test', updatedAt: 'v1' });
    data(await call('school.select', { schoolId: 'bjtu' })); data(await other('school.select', { schoolId: 'bjtu' }));

    await t.test('five concurrent chat sends have no daily cap; same requests and steps remain idempotent', async () => {
      const conversations = await Promise.all(Array.from({ length: 5 }, (_, i) => create(`sql-conversation-${i}-0001`)));
      const inputs = conversations.map((conversation, i) => inputFor(conversation.id, `sql-chat-send-${i}-0001`));
      const results = await Promise.all(inputs.map(input => call('ai.chat.send', input)));
      assert.equal(results.filter(result => result.ok).length, 5, JSON.stringify(results));
      assert.ok(results.every(result => result.ok));
      for (let i = 0; i < results.length; i++) if (results[i].ok) winners.push({ conversation: conversations[i], turn: data<AiChatTurn>(results[i]), input: inputs[i] });
      assert.equal((await quota()).held, 5); assert.equal((await quota()).used, 0); assert.equal(calls, 0);
      const before = await sql.query("SELECT count(*) AS count FROM campus_documents WHERE collection='web_ai_tasks'");
      const retries = await Promise.all(Array.from({ length: 5 }, () => call('ai.chat.send', winners[0].input)));
      assert.ok(retries.every(result => data<AiChatTurn>(result).taskId === winners[0].turn.taskId));
      assert.equal((await quota()).held, 5);
      const after = await sql.query("SELECT count(*) AS count FROM campus_documents WHERE collection='web_ai_tasks'");
      assert.equal(Number(after.rows[0].count), Number(before.rows[0].count));
      const changed = await call('ai.chat.send', { ...winners[0].input, question: '另一个问题' });
      assert.equal(changed.ok, false); if (!changed.ok) assert.equal(changed.code, 'REQUEST_CONFLICT');
      for (const winner of winners) {
        const stored = await db.collection('web_ai_tasks').doc(winner.turn.taskId!).get();
        assert.equal((stored.data as any).expireAt, winner.conversation.expireAt);
        assert.ok((stored.data as any).chat.history.length <= 3500);
      }
      for (const extra of winners.splice(3)) data(await call('ai.chat.cancel', { conversationId: extra.conversation.id, turnId: extra.turn.id }));
      assert.equal((await quota()).held, 3);
    });

    await t.test('chat and legacy official tasks share one account; cancel and uncertain resolve release only once', async () => {
      const first = winners[0];
      const cancelInput = { conversationId: first.conversation.id, turnId: first.turn.id };
      assert.equal(data<AiChatTurn>(await call('ai.chat.cancel', cancelInput)).quotaHeld, false);
      data(await call('ai.chat.cancel', cancelInput)); assert.equal((await quota()).held, 2);
      legacy = data<ReadingTask>(await call('ai.start', { schoolId: 'bjtu', itemIds: ['sql-chat-notice'], requestId: 'sql-legacy-start-0001', service: 'official', task: 'summary' }));
      assert.equal((await quota()).held, 3);
      const conversation = await create('sql-replacement-chat-01');
      const additional = data<AiChatTurn>(await call('ai.chat.send', inputFor(conversation.id, 'sql-replacement-unlimited-01')));
      assert.equal((await quota()).held, 4);
      data(await call('ai.chat.cancel', { conversationId: conversation.id, turnId: additional.id }));
      data(await call('ai.cancel', { taskId: legacy.id })); data(await call('ai.cancel', { taskId: legacy.id }));
      assert.equal((await quota()).held, 2);
      const turn = data<AiChatTurn>(await call('ai.chat.send', inputFor(conversation.id, 'sql-replacement-ready-01')));
      replacement = { conversation, turn }; assert.equal((await quota()).held, 3);
      const second = winners[1];
      const step = { conversationId: second.conversation.id, turnId: second.turn.id, step: 0 };
      second.turn = data<AiChatTurn>(await call('ai.chat.step', step));
      assert.equal(calls, 1); data(await call('ai.chat.step', step)); assert.equal(calls, 1);
      second.turn = await finish(second.conversation.id, second.turn);
      assert.equal(second.turn.state, 'complete'); assert.equal((await quota()).used, 1); assert.equal((await quota()).held, 2);
      uncertain = true;
      const third = winners[2]; third.turn = await finish(third.conversation.id, third.turn);
      assert.equal(third.turn.state, 'uncertain'); assert.equal((await quota()).held, 2);
      const recovery = { conversationId: third.conversation.id, turnId: third.turn.id };
      assert.equal(data<AiChatTurn>(await call('ai.chat.cancel', recovery)).quotaHeld, true);
      assert.equal(data<AiChatTurn>(await call('ai.chat.resolve', { ...recovery, charged: false })).quotaHeld, false);
      data(await call('ai.chat.resolve', { ...recovery, charged: false }));
      assert.equal((await quota()).held, 1); assert.equal((await quota()).used, 1);
      data(await call('ai.chat.cancel', { conversationId: replacement.conversation.id, turnId: replacement.turn.id }));
      assert.equal((await quota()).held, 0);
      const account = await sql.query("SELECT body FROM campus_documents WHERE collection='web_ai_accounts' AND body->>'owner'=$1", ['sql-chat-owner']);
      assert.equal(account.rows.length, 1); assert.equal(account.rows[0].body.used, 1); assert.equal(account.rows[0].body.held, 0);
    });

    await t.test('another account cannot read, run or settle chat turns; expiry does not extend on followup', async () => {
      const ownerBefore = await quota(), winner = winners[1], beforeCalls = calls;
      for (const action of ['ai.chat.get', 'ai.chat.send', 'ai.chat.step', 'ai.chat.cancel', 'ai.chat.resolve']) {
        const input = action === 'ai.chat.get' ? { conversationId: winner.conversation.id }
          : action === 'ai.chat.send' ? inputFor(winner.conversation.id, 'sql-foreign-send-0001')
          : { conversationId: winner.conversation.id, turnId: winner.turn.id, ...(action === 'ai.chat.step' ? { step: 0 } : action === 'ai.chat.resolve' ? { charged: false } : {}) };
        const denied = await other(action, input); assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.code, 'NOT_FOUND');
      }
      assert.equal(calls, beforeCalls); assert.deepEqual(await quota(), ownerBefore);
      assert.equal(data<any>(await other('ai.status')).quota.remaining, null);
      const theirs = await create('sql-other-conversation-01', other);
      const theirTurn = data<AiChatTurn>(await other('ai.chat.send', inputFor(theirs.id, winner.input.requestId)));
      assert.notEqual(theirTurn.taskId, winner.turn.taskId); assert.deepEqual(await quota(), ownerBefore);
      data(await other('ai.chat.cancel', { conversationId: theirs.id, turnId: theirTurn.id }));
      uncertain = false; clock += 60000;
      const followup = data<AiChatTurn>(await call('ai.chat.send', { conversationId: winner.conversation.id, requestId: 'sql-expiry-followup-01', question: '还有什么需要注意？' }));
      const task = await db.collection('web_ai_tasks').doc(followup.taskId!).get();
      assert.equal((task.data as any).expireAt, winner.conversation.expireAt);
      data(await call('ai.chat.cancel', { conversationId: winner.conversation.id, turnId: followup.id }));
      clock += 86400001;
      const expired = await call('ai.chat.get', { conversationId: winner.conversation.id });
      assert.equal(expired.ok, false); if (!expired.ok) assert.equal(expired.code, 'RESULT_EXPIRED');
      const stored = await db.collection('web_ai_conversations').doc(winner.conversation.id).get();
      assert.equal((stored.data as any).purged, true); assert.equal((stored.data as any).turns, undefined);
      const purgedTask = await db.collection('web_ai_tasks').doc(winner.turn.taskId!).get();
      assert.equal((purgedTask.data as any).docs, undefined); assert.equal((purgedTask.data as any).result, undefined);
    });
  } finally { await pool.end(); await server.stop(); }
});
