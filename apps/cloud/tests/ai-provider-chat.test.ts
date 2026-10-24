import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NetlifyDB } from '@netlify/database-dev';
import { getDatabase } from '@netlify/database';
import type { AiChatTurn, AiConversation, AiProviderState, AiSavedProvider, GatewayResult } from '@campus/contracts';
import { providerProfiles, type ProviderProfiles } from '../src/ai-provider-profiles';
import { postgresStorage, type SqlPool } from '../src/postgres-storage';
import { postgresRepository } from '../src/postgres-repository';
import { aiService } from '../src/ai-service';
import { assistantChat } from '../src/assistant-chat';
import { createGateway } from '../src/gateway';
import type { Connection } from '../src/model-provider';

test('saved provider chat lifecycle with real local SQL never persists credentials in tasks or conversations', async t => {
  const server = new NetlifyDB({ logger() {} }), connectionString = await server.start(), native = getDatabase({ connectionString }).pool;
  (native as unknown as { options: { max: number } }).options.max = 1;
  const sql = native as unknown as SqlPool, db = postgresStorage(sql), repo = postgresRepository(sql);
  const store = providerProfiles(sql, { encryptionKey: () => Buffer.alloc(32, 43).toString('base64') });
  const records: Connection[] = []; let hook: (() => Promise<void>) | undefined, uncertain = false, beforeGuard: (() => Promise<void>) | undefined, serial = 0;
  const providers: ProviderProfiles = { ...store, async resolve(...args) { const value = await store.resolve(...args); if (beforeGuard) { const work = beforeGuard; beforeGuard = undefined; await work(); } return value; } };
  const oldMode = process.env.AI_EXECUTION_MODE; process.env.AI_EXECUTION_MODE = 'direct';
  const ai = aiService(db, repo, async connection => { records.push({ ...connection }); if (hook) { const work = hook; hook = undefined; await work(); } if (uncertain) throw Object.assign(new Error('synthetic timeout'), { code: 'MODEL_UNCERTAIN' }); return '报名资料 [R1](https://www.bjtu.edu.cn/provider-fixture)'; }, Date.now, undefined, providers);
  const chat = assistantChat(db, repo, ai, async () => ({ items: [], search: { state: 'idle', message: '合成测试' } } as any), Date.now, undefined, providers);
  const asOwner = (owner: string) => {
    const gateway = createGateway(repo, { ownerUid: owner, dataOwnerId: owner }, Date.now, { ai: { handle: (action, input, identity) => action.startsWith('ai.chat.') ? chat.handle(action, input, identity) : ai.handle(action, input, identity) } });
    return (action: string, input: Record<string, unknown> = {}) => gateway({ action, input }, { uid: owner, isAnonymous: false });
  };
  const call = asOwner('saved-chat-owner'), other = asOwner('saved-chat-other');
  function data<T>(result: GatewayResult<unknown>): T { assert.ok(result.ok, JSON.stringify(result)); return result.data as T; }
  const state = async () => data<AiProviderState>(await call('ai.providers.list'));
  const ref = (p: AiSavedProvider) => ({ id: p.id, version: p.version });
  const add = async (name: string) => {
    const s = await state(); return data<AiProviderState>(await call('ai.providers.save', { profile: { version: s.version, name, protocol: 'openai-responses', baseUrl: 'https://provider.example/v1', models: ['fixture-model', 'second-model'], defaultModel: 'fixture-model', apiKey: `synthetic-secret-${name}` } })).profiles.find(p => p.name === name)!;
  };
  const edit = async (p: AiSavedProvider) => { const s = await state(); return data<AiProviderState>(await call('ai.providers.save', { profile: { version: s.version, id: p.id, profileVersion: p.version, name: `${p.name} edited`, protocol: p.protocol, baseUrl: p.baseUrl, models: p.models, defaultModel: p.defaultModel } })); };
  const remove = async (p: AiSavedProvider) => data(await call('ai.providers.remove', { id: p.id, version: (await state()).version }));
  const create = async () => data<AiConversation>(await call('ai.chat.create', { schoolId: 'bjtu', requestId: `saved-conversation-${++serial}` }));
  const send = async (c: AiConversation, p: AiSavedProvider) => data<AiChatTurn>(await call('ai.chat.send', { conversationId: c.id, requestId: `saved-question-${++serial}`, question: '需要哪些报名材料？', itemIds: ['provider-notice'], service: 'byok', providerProfile: ref(p), model: 'fixture-model' }));
  const step = async (c: AiConversation, turn: AiChatTurn) => data<AiChatTurn>(await call('ai.chat.step', { conversationId: c.id, turnId: turn.id, step: turn.step }));
  try {
    await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations', import.meta.url)));
    await db.collection('sources').doc('provider-source').set({ scope: 'school', schoolIds: ['bjtu'], enabled: true, aiProcessing: 'allow' });
    await db.collection('items').doc('provider-notice').set({ title: '合成报名公告', contentText: '报名请提交材料。', sourceId: 'provider-source', scope: 'school', schoolIds: ['bjtu'], status: 'published', publishedAt: new Date().toISOString(), originalUrl: 'https://www.bjtu.edu.cn/provider-fixture', updatedAt: 'v1' });
    data(await call('school.select', { schoolId: 'bjtu' })); data(await other('school.select', { schoolId: 'bjtu' }));

    await t.test('selection switches only future turns, with no credential in gateway DTOs or general documents', async () => {
      const a = await add('alpha'), b = await add('beta'), c = await create();
      data(await call('ai.providers.select', { id: a.id, model: 'fixture-model', version: (await state()).version }));
      let turn = await send(c, a); const calls = records.length;
      data(await call('ai.providers.select', { id: b.id, model: 'second-model', version: (await state()).version })); assert.equal(records.length, calls);
      while (turn.state === 'ready') turn = await step(c, turn);
      assert.equal(turn.state, 'complete'); assert.equal(turn.model, 'fixture-model'); assert.deepEqual(turn.providerProfile, ref(a));
      assert.ok(records.slice(calls).every(r => r.apiKey === 'synthetic-secret-alpha' && r.protocol === 'openai-responses'));
      const documents = await sql.query("SELECT body FROM campus_documents WHERE collection IN ('web_ai_tasks','web_ai_conversations')");
      assert.doesNotMatch(JSON.stringify(documents.rows), /synthetic-secret-|key_ciphertext|apiKey/); assert.doesNotMatch(JSON.stringify(await state()), /synthetic-secret-|key_ciphertext|apiKey/);
      await remove(a);
      const restored = data<AiConversation>(await call('ai.chat.get', { conversationId: c.id })); assert.equal(restored.turns[0].state, 'complete'); assert.ok(restored.turns[0].result);
      const quota = data<any>(await call('ai.status')).quota; assert.equal(quota.used, 0); assert.equal(quota.held, 0);
    });

    await t.test('owner isolation and gateway whitelist reject foreign references and injected credentials', async () => {
      const p = await add('private'); const theirs = data<AiConversation>(await other('ai.chat.create', { schoolId: 'bjtu', requestId: 'foreign-profile-conversation' }));
      const denied = await other('ai.chat.send', { conversationId: theirs.id, requestId: 'foreign-provider-question', question: '材料？', itemIds: ['provider-notice'], service: 'byok', providerProfile: ref(p), model: 'fixture-model' });
      assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.code, 'PROVIDER_PROFILE_CHANGED');
      const invalid = await call('ai.providers.list', { owner: 'saved-chat-other' }); assert.equal(invalid.ok, false);
      const invalidSend = await call('ai.chat.send', { conversationId: (await create()).id, requestId: 'injected-key-request', question: '材料？', providerProfile: ref(p), service: 'byok', model: 'fixture-model', apiKey: 'do-not-accept' }); assert.equal(invalidSend.ok, false);
    });

    await t.test('edit before execution terminates old tasks and releases conversation pending state', async () => {
      const p = await add('before'), c = await create(), turn = await send(c, p), calls = records.length;
      const changed = await edit(p); const restored = data<AiConversation>(await call('ai.chat.get', { conversationId: c.id }));
      assert.equal(restored.turns[0].state, 'failed'); assert.equal(records.length, calls);
      const next = await send(c, changed.profiles.find(v => v.id === p.id)!); assert.equal(next.state, 'ready'); data(await call('ai.chat.cancel', { conversationId: c.id, turnId: next.id }));
      assert.equal((data<any>(await call('ai.task', { taskId: turn.taskId })).state), 'failed');
    });

    await t.test('edit during intermediate batch and delete during final response both discard output', async () => {
      for (const final of [false, true]) {
        const p = await add(final ? 'during-final' : 'during-batch'), c = await create(); let turn = await send(c, p);
        if (final) turn = await step(c, turn);
        hook = async () => { if (final) await remove(p); else await edit(p); };
        turn = await step(c, turn); assert.equal(turn.state, 'failed'); assert.equal(turn.result, null);
        const stored = await db.collection('web_ai_tasks').doc(turn.taskId!).get(); assert.equal((stored.data as any).notes.length, final ? 1 : 0);
        const current = data<AiConversation>(await call('ai.chat.get', { conversationId: c.id })); assert.equal(current.turns[0].state, 'failed');
      }
    });

    await t.test('profile changes between key resolution and batch claim stop before the network', async () => {
      const p = await add('claim-race'), c = await create(), turn = await send(c, p), calls = records.length;
      beforeGuard = async () => { await edit(p); };
      const stopped = await step(c, turn); assert.equal(stopped.state, 'failed'); assert.equal(records.length, calls);
      const current = data<AiConversation>(await call('ai.chat.get', { conversationId: c.id })); assert.equal(current.turns[0].state, 'failed');
    });

    await t.test('unknown BYOK calls can explicitly finish and settle after profile deletion without replay', async () => {
      const p = await add('uncertain'), c = await create(); let turn = await send(c, p); uncertain = true; turn = await step(c, turn); uncertain = false;
      assert.equal(turn.state, 'uncertain'); assert.equal(turn.quotaHeld, false); const calls = records.length;
      await remove(p);
      const ended = data<AiChatTurn>(await call('ai.chat.cancel', { conversationId: c.id, turnId: turn.id })); assert.equal(ended.state, 'cancelled');
      const settled = data<AiChatTurn>(await call('ai.chat.resolve', { conversationId: c.id, turnId: turn.id, charged: true })); assert.equal(settled.state, 'cancelled'); assert.equal(records.length, calls);
      const q = await add('recovery'); assert.equal((await send(c, q)).state, 'ready');
      assert.equal(data<any>(await call('ai.status')).quota.used, 0);
    });
  } finally { if (oldMode === undefined) delete process.env.AI_EXECUTION_MODE; else process.env.AI_EXECUTION_MODE = oldMode; await native.end(); await server.stop(); }
});
