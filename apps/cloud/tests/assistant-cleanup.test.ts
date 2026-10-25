import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetlifyDB } from '@netlify/database-dev';
import { getDatabase } from '@netlify/database';
import { fileURLToPath } from 'node:url';
import { cleanupAssistantData } from '../src/assistant-cleanup';
import { postgresStorage, type SqlPool } from '../src/postgres-storage';

test('real SQL assistant retention removes sensitive bodies and prunes opt-in behavior without overwriting profile data', async () => {
  const server = new NetlifyDB({ logger() {} }), connectionString = await server.start();
  const pool = getDatabase({ connectionString }).pool; (pool as any).options.max = 1;
  const sql = pool as unknown as SqlPool, db = postgresStorage(sql), now = Date.now();
  try {
    await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations', import.meta.url)));
    const put = (c: string, id: string, body: Record<string, unknown>) => db.collection(c).doc(id).set({ _id: id, ...body });
    await put('web_ai_conversations', 'old-conv', { owner: 'u', schoolId: 'bjtu', turns: [{ question: 'private' }], expireAt: new Date(now - 1).toISOString() });
    await put('web_ai_tasks', 'old-task', { docs: ['private'], result: 'private', chat: { history: 'private' }, memoryProposals: [{ text: 'private' }], expireAt: new Date(now - 1).toISOString() });
    await put('items', 'old-search', { contentText: 'private', aiSearchExpiresAt: new Date(now - 1).toISOString(), status: 'published' });
    const fresh = { itemId: 'new', at: now - 10, day: '2026-10-19', categories: ['academic'] };
    await put('user_profiles', 'u', { selectedSchoolId: 'bjtu', webBookmarks: ['keep'], aiAssistant: { bjtu: { preferences: { learningEnabled: true, version: 2 }, dismissed: ['keep'], behaviorClearedAt: 5, behavior: [fresh, { ...fresh, itemId: 'old', at: now - 31 * 86400000 }] }, other: { preferences: { learningEnabled: false }, behavior: [fresh] } } });
    const observedAt = new Date(now - 31 * 86400000).toISOString();
    await put('user_profiles', 'memory-only', { unrelated: 'keep', aiMemory: { bjtu: { enabled: true, generation: 3, version: 4, items: [{ id: 'progress', slot: 'progress', text: 'private obsolete stage', createdAt: observedAt, updatedAt: observedAt, expiresAt: new Date(now - 1).toISOString() }], processedRequests: ['keep-request'] } } });
    await put('user_profiles', 'linked-memory', { aiMemory: { bjtu: { enabled: true, version: 1, items: [
      { id: 'goal_linked', slot: 'goal', text: 'obsolete goal', createdAt: observedAt, updatedAt: observedAt, expiresAt: new Date(now - 1).toISOString() },
      { id: 'progress_linked', slot: 'progress', goalId: 'goal_linked', text: 'orphan stage', createdAt: observedAt, updatedAt: observedAt, expiresAt: new Date(now + 10000).toISOString() },
    ], commandRequests: [
      { requestId: 'keep-command', at: new Date(now - 47 * 3600000).toISOString(), fingerprint: 'keep', result: { handled: true, changed: true, message: 'done' } },
      { requestId: 'expired-command', at: new Date(now - 48 * 3600000).toISOString(), fingerprint: 'expired', result: { handled: true, changed: true } },
      { requestId: 'undated-command', fingerprint: 'unknown', result: { handled: true, changed: false } },
    ] } } });
    await cleanupAssistantData(sql, now);
    const row = async (c: string, id: string) => (await db.collection(c).doc(id).get()).data as any;
    assert.equal((await row('web_ai_conversations', 'old-conv')).turns, undefined);
    assert.equal((await row('web_ai_tasks', 'old-task')).chat, undefined);
    assert.equal((await row('web_ai_tasks', 'old-task')).memoryProposals, undefined);
    assert.equal((await row('items', 'old-search')).contentText, undefined);
    assert.equal((await row('items', 'old-search')).status, 'withdrawn');
    const p = await row('user_profiles', 'u'); assert.deepEqual(p.webBookmarks, ['keep']); assert.equal(p.selectedSchoolId, 'bjtu');
    assert.deepEqual(p.aiAssistant.bjtu.behavior, [fresh]); assert.deepEqual(p.aiAssistant.other.behavior, []);
    assert.equal(p.aiAssistant.bjtu.preferences.version, 2); assert.deepEqual(p.aiAssistant.bjtu.dismissed, ['keep']);
    const memory = await row('user_profiles', 'memory-only');
    assert.equal(memory.unrelated, 'keep');
    assert.deepEqual(memory.aiMemory.bjtu.items, []);
    assert.equal(memory.aiMemory.bjtu.updatedAtBySlot.progress, observedAt);
    assert.equal(memory.aiMemory.bjtu.generation, 3);
    const linked = (await row('user_profiles', 'linked-memory')).aiMemory.bjtu;
    assert.deepEqual(linked.items, []);
    assert.equal(linked.updatedAtByItem.goal_linked, observedAt);
    assert.equal(linked.updatedAtByItem.progress_linked, observedAt);
    assert.equal(linked.commandRequests[0].requestId, 'keep-command');
    assert.equal(linked.commandRequests.length, 1);
    await cleanupAssistantData(sql, now); assert.deepEqual((await row('user_profiles', 'u')).aiAssistant.bjtu.behavior, [fresh]);
  } finally { await pool.end(); await server.stop(); }
});
