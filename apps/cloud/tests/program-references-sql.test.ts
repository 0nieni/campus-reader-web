import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetlifyDB } from '@netlify/database-dev';
import { getDatabase } from '@netlify/database';
import { fileURLToPath } from 'node:url';
import { postgresRepository } from '../src/postgres-repository';
import { postgresStorage, type SqlPool } from '../src/postgres-storage';
import { filterProgramReferences } from '../src/program-references';
import { digest } from '../src/reading-package';

test('production SQL program links honor hidden same-URL rows without exposing foreign owner records', async t => {
  const server = new NetlifyDB({ logger() {} });
  const pool = getDatabase({ connectionString: await server.start() }).pool;
  (pool as unknown as { options: { max: number } }).options.max = 1;
  const sql = pool as unknown as SqlPool, repo = postgresRepository(sql), db = postgresStorage(sql);
  const owner = 'policy-owner', url = 'https://www.example.com/competition';
  const candidate = { reference: 'R1', itemId: 'ai_search_item_' + digest([owner, 'bjtu', url]), title: '比赛公告', originalUrl: url };
  const row = { title: candidate.title, originalUrl: url, canonicalUrl: url + '#section', sourceId: 'policy-source', scope: 'school', schoolIds: ['bjtu'], status: 'published', publishedAt: new Date().toISOString() };
  const run = () => filterProgramReferences(db, repo, owner, 'bjtu', [candidate]);
  try {
    await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations', import.meta.url)));
    await repo.selectSchool(owner, 'bjtu');
    await db.collection('sources').doc('policy-source').set({ scope: 'school', schoolIds: ['bjtu'], aiProcessing: 'allow', enabled: true });
    await t.test('unknown public links are displayed', async () => { assert.deepEqual(await run(), [candidate]); });
    await t.test('withdrawn and current-school-invisible same-URL records suppress virtual links', async () => {
      for (const patch of [{ status: 'withdrawn' }, { schoolIds: ['other'] }]) {
        await db.collection('items').doc('known-policy-row').set({ ...row, ...patch });
        assert.ok(!(await repo.items(await repo.scope('bjtu', owner), 0, 100, '2000-01-01')).some(value => value._id === 'known-policy-row'), 'feed SQL intentionally hides the record');
        assert.deepEqual(await run(), [], JSON.stringify(patch));
      }
    });
    await t.test('a source removed from the school still revokes its school-associated same URL', async () => {
      await db.collection('items').doc('known-policy-row').set(row);
      await db.collection('sources').doc('policy-source').set({ scope: 'school', schoolIds: ['other'] });
      assert.deepEqual(await run(), []);
    });
    await t.test('foreign private and unrelated-school records cannot affect or leak through URL policy checks', async () => {
      for (const patch of [
        { scope: 'private', ownerOpenid: 'other-owner', schoolIds: ['bjtu'] },
        { scope: 'school', schoolIds: ['other'] },
      ]) {
        await db.collection('items').doc('known-policy-row').set({ ...row, ...patch, status: 'withdrawn' });
        assert.deepEqual(await run(), [candidate]);
      }
    });
    await t.test('more than 200 exact same-URL matches fail closed', async () => {
      const values = Array.from({ length: 201 }, (_, index) => `('items','duplicate-${index}', $1::jsonb)`).join(',');
      await sql.query(`INSERT INTO campus_documents(collection,id,body) VALUES ${values}`, [JSON.stringify({ ...row, status: 'withdrawn' })]);
      assert.deepEqual(await run(), []);
    });
    await t.test('a stored temporary search identity cannot bypass known same-URL withdrawal', async () => {
      await sql.query("DELETE FROM campus_documents WHERE collection='items' AND id LIKE 'duplicate-%'");
      await db.collection('sources').doc('policy-source').set({ scope: 'school', schoolIds: ['bjtu'], aiProcessing: 'allow' });
      await db.collection('items').doc('known-policy-row').set({ ...row, status: 'withdrawn' });
      const sourceId = 'ai_search_' + digest([owner, 'bjtu']);
      await db.collection('sources').doc(sourceId).set({ scope: 'private', ownerOpenid: owner, schoolIds: ['bjtu'], type: 'ai_search', autoCollect: false, aiProcessing: 'allow' });
      await db.collection('items').doc(candidate.itemId).set({ ...row, scope: 'private', ownerOpenid: owner, sourceId, importKind: 'website', aiProcessing: 'allow' });
      assert.deepEqual(await run(), []);
    });
  } finally { await pool.end(); await server.stop(); }
});
