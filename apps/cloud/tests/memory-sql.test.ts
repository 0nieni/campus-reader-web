import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NetlifyDB } from '@netlify/database-dev';
import { getDatabase } from '@netlify/database';
import { postgresStorage, type SqlPool } from '../src/postgres-storage';
import { postgresRepository } from '../src/postgres-repository';
import { memoryService } from '../src/assistant-memory';
import { assistantProfile } from '../src/assistant-profile';
import { identity } from './feature-fixture';

test('real SQL memory writes use one connection and preserve explicit preferences and unrelated profile fields', async () => {
  const server = new NetlifyDB({ logger() {} }), connectionString = await server.start();
  const pool = getDatabase({ connectionString }).pool; (pool as any).options.max = 1;
  let transactionActive = false;
  const guarded: SqlPool = {
    async query(sql, values) {
      assert.equal(transactionActive, false, 'a transaction must not request another pool connection');
      return pool.query(sql, values) as any;
    },
    async connect() {
      const client = await pool.connect(); transactionActive = true;
      return { query: (sql, values) => client.query(sql, values) as any, release() { transactionActive = false; client.release(); } };
    },
  };
  try {
    await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations', import.meta.url)));
    const db = postgresStorage(guarded), repo = postgresRepository(guarded), memory = memoryService(db, repo);
    await repo.selectSchool(identity.dataOwnerId, 'bjtu');
    await db.collection('user_profiles').doc(identity.dataOwnerId).update({ webBookmarks: ['keep'] });
    const state = await memory.get(identity.dataOwnerId, 'bjtu'); assert.equal(state.enabled, true);
    const observedAt = new Date(Date.now() - 1000).toISOString();
    assert.equal(await memory.apply(identity.dataOwnerId, 'bjtu', { requestId: 'sql-memory-request-001', question: '我对编程感兴趣', proposals: [{ slot: 'interests', text: '我对编程感兴趣', evidence: '我对编程感兴趣' }], generation: state.generation, observedAt }), 1);
    await assistantProfile(db, repo).handle('ai.profile.save', { schoolId: 'bjtu', interests: ['学术'], goals: '寻找讲座', learningEnabled: false, version: 0 }, identity);
    const after = await memory.get(identity.dataOwnerId, 'bjtu'); assert.equal(after.items[0].text, '我对编程感兴趣');
    await memory.handle('ai.memory.forget', { schoolId: 'bjtu', id: 'interests', version: after.version }, identity);
    const row = (await db.collection('user_profiles').doc(identity.dataOwnerId).get()).data as any;
    assert.deepEqual(row.webBookmarks, ['keep']);
    assert.equal(row.aiAssistant.bjtu.preferences.goals, '寻找讲座');
    assert.deepEqual((await memory.get(identity.dataOwnerId, 'bjtu')).items, []);
    assert.equal(await memory.apply(identity.dataOwnerId, 'bjtu', { requestId: 'sql-memory-late-0001', question: '我对编程感兴趣', proposals: [{ slot: 'interests', text: '我对编程感兴趣', evidence: '我对编程感兴趣' }], generation: 0, observedAt }), 0);
  } finally { await pool.end(); await server.stop(); }
});
