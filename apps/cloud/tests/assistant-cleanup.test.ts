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
    await put('web_ai_tasks', 'old-task', { docs: ['private'], result: 'private', chat: { history: 'private' }, expireAt: new Date(now - 1).toISOString() });
    await put('items', 'old-search', { contentText: 'private', aiSearchExpiresAt: new Date(now - 1).toISOString(), status: 'published' });
    const fresh = { itemId: 'new', at: now - 10, day: '2026-10-19', categories: ['academic'] };
    await put('user_profiles', 'u', { selectedSchoolId: 'bjtu', webBookmarks: ['keep'], aiAssistant: { bjtu: { preferences: { learningEnabled: true, version: 2 }, dismissed: ['keep'], behaviorClearedAt: 5, behavior: [fresh, { ...fresh, itemId: 'old', at: now - 31 * 86400000 }] }, other: { preferences: { learningEnabled: false }, behavior: [fresh] } } });
    await cleanupAssistantData(sql, now);
    const row = async (c: string, id: string) => (await db.collection(c).doc(id).get()).data as any;
    assert.equal((await row('web_ai_conversations', 'old-conv')).turns, undefined);
    assert.equal((await row('web_ai_tasks', 'old-task')).chat, undefined);
    assert.equal((await row('items', 'old-search')).contentText, undefined);
    assert.equal((await row('items', 'old-search')).status, 'withdrawn');
    const p = await row('user_profiles', 'u'); assert.deepEqual(p.webBookmarks, ['keep']); assert.equal(p.selectedSchoolId, 'bjtu');
    assert.deepEqual(p.aiAssistant.bjtu.behavior, [fresh]); assert.deepEqual(p.aiAssistant.other.behavior, []);
    assert.equal(p.aiAssistant.bjtu.preferences.version, 2); assert.deepEqual(p.aiAssistant.bjtu.dismissed, ['keep']);
    await cleanupAssistantData(sql, now); assert.deepEqual((await row('user_profiles', 'u')).aiAssistant.bjtu.behavior, [fresh]);
  } finally { await pool.end(); await server.stop(); }
});
