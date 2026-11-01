import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetlifyDB } from '@netlify/database-dev';
import { getDatabase } from '@netlify/database';
import { fileURLToPath } from 'node:url';
import { postgresRepository } from '../src/postgres-repository';
import { postgresStorage, type SqlPool } from '../src/postgres-storage';
import { filterProgramReferences } from '../src/program-references';
import { digest } from '../src/reading-package';
import { assistantService } from '../src/assistant-service';
import { aiService } from '../src/ai-service';

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
    await t.test('URL-equivalent withdrawn records cannot evade the application URL normalization', async () => {
      for (const rawUrl of ['https://WWW.EXAMPLE.COM:443/competition#section', 'https://www.example.com/a/../competition', 'https://www.example.com\\competition']) {
        await db.collection('items').doc('known-policy-row').set({ ...row, originalUrl: rawUrl, canonicalUrl: rawUrl, status: 'withdrawn' });
        assert.deepEqual(await run(), [], rawUrl);
      }
    });
    await t.test('a legacy source-only row still revokes links after its source moves to another school', async () => {
      const { scope: _scope, schoolIds: _schoolIds, ...legacy } = row;
      await db.collection('items').doc('known-policy-row').set(legacy);
      await db.collection('sources').doc('policy-source').set({ scope: 'school', schoolIds: ['other'] });
      assert.deepEqual(await run(), []);
      await db.collection('sources').doc('policy-source').set({ scope: 'school', schoolIds: ['bjtu'], aiProcessing: 'allow' });
    });
    await t.test('ambiguous ownerless legacy children of now-private sources fail closed without returning private bodies', async () => {
      const { scope: _scope, schoolIds: _schoolIds, ...legacy } = row;
      await db.collection('items').doc('known-policy-row').set(legacy);
      await db.collection('sources').doc('policy-source').set({ scope: 'private', ownerOpenid: 'other-owner' });
      try {
        const blocked = await repo.itemsForUrlPolicy!(await repo.scope('bjtu', owner), url);
        assert.ok(blocked?.length, 'only matching denial metadata is returned, never private source child bodies');
        assert.ok(blocked.every(value => !value.contentText && !value.title));
        assert.deepEqual(await run(), []);
        assert.deepEqual(await repo.itemsForUrlPolicy!(await repo.scope('bjtu', owner), 'https://www.example.com/unrelated'), [], 'unrelated private orphan must not disable all links');
      } finally {
        await db.collection('sources').doc('policy-source').set({ scope: 'school', schoolIds: ['bjtu'], aiProcessing: 'allow' });
      }
    });
    await t.test('withdrawn and current-school-invisible same-URL records suppress virtual links', async () => {
      await db.collection('sources').doc('policy-source').set({ scope: 'school', schoolIds: ['bjtu'], aiProcessing: 'allow' });
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
    await t.test('foreign private rows are excluded and foreign-school public rows may only deny links', async () => {
      for (const [patch, expected] of [
        [{ scope: 'private', ownerOpenid: 'other-owner', schoolIds: ['bjtu'] }, [candidate]],
        [{ scope: 'school', schoolIds: ['other'] }, []],
      ] as const) {
        await db.collection('items').doc('known-policy-row').set({ ...row, ...patch, status: 'withdrawn' });
        assert.deepEqual(await run(), expected);
        if ('ownerOpenid' in patch) assert.deepEqual(await repo.itemsForUrlPolicy!(await repo.scope('bjtu', owner), url), [], 'foreign-owner body is never returned by SQL policy query');
      }
    });
    await t.test('more than 200 exact same-URL matches fail closed', async () => {
      const values = Array.from({ length: 201 }, (_, index) => `('items','duplicate-${index}', $1::jsonb)`).join(',');
      await sql.query(`INSERT INTO campus_documents(collection,id,body) VALUES ${values}`, [JSON.stringify({ ...row, status: 'withdrawn' })]);
      assert.deepEqual(await run(), []);
    });
    await t.test('201 unrelated public records do not prevent a full URL policy match or safe new import', async () => {
      await sql.query("UPDATE campus_documents SET body=jsonb_set(jsonb_set(body,'{originalUrl}',to_jsonb('https://www.example.com/' || id)),'{canonicalUrl}',to_jsonb('https://www.example.com/' || id)) WHERE collection='items' AND id LIKE 'duplicate-%'");
      await sql.query("UPDATE campus_documents SET body=jsonb_set(body,'{schoolIds}','[\"other\"]'::jsonb) WHERE collection='items' AND id LIKE 'duplicate-%'");
      assert.deepEqual(await repo.itemsForUrlPolicy!(await repo.scope('bjtu', owner), 'https://www.example.com/unknown'), []);
      const target = await repo.itemsForUrlPolicy!(await repo.scope('bjtu', owner), 'https://www.example.com/duplicate-99');
      assert.ok(target?.some(value => value._id === 'duplicate-99'), 'lexically late target beyond the first 200 metadata rows is found');
      let reads = 0;
      const safeUrl = 'https://www.example.com/new-safe-page';
      const assistant = assistantService(db, repo, aiService(db, repo), () => Date.now() - 16000,
        async () => ({ state: 'complete', message: '搜索完成', candidates: [{ url: safeUrl, title: '安全新网页', snippet: '' }] }),
        async targetUrl => { reads++; return { url: targetUrl, html: '<article>仅用于本地SQL测试的安全新网页正文。二百零一条无关公开记录不应导致所有新搜索失效，正文可在来源核验后用于本次提问。</article>' }; });
      const result = await assistant.handle('ai.recommend', { schoolId: 'bjtu', search: true }, { dataOwnerId: owner } as any) as any;
      assert.equal(reads, 1); assert.equal(result.search.readableCount, 1);
      assert.ok(result.items.some((value: any) => value.originalUrl === safeUrl && value.allowAi));
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
    await t.test('discovery cannot reimport withdrawn same-URL body through a fresh temporary search identity', async () => {
      // Make the candidate unstored; only the withdrawn original row remains.
      await sql.query("DELETE FROM campus_documents WHERE collection='items' AND id=$1", [candidate.itemId]);
      let reads = 0;
      const assistant = assistantService(db, repo, aiService(db, repo), Date.now,
        async () => ({ state: 'complete', message: '搜索完成', candidates: [{ url, title: candidate.title, snippet: '不能当正文' }] }),
        async target => { reads++; return { url: target, html: '<article>仅供测试的公开资料正文。不能使用新的搜索身份绕过数据库已有公告的撤回状态和来源策略。此段长度满足正文提取条件。</article>' }; });
      const result = await assistant.handle('ai.recommend', { schoolId: 'bjtu', query: '比赛', search: true }, { dataOwnerId: owner } as any) as any;
      assert.equal(reads, 0);
      assert.equal(result.search.readableCount, 0);
      assert.equal(await repo.item(candidate.itemId), null);
    });
    await t.test('policy metadata never includes collected bodies or attachment payloads', async () => {
      await db.collection('items').doc('known-policy-row').set({ ...row, contentText: 'private-body-sentinel', materialArchive: { files: ['secret-attachment'] } });
      const metadata = await repo.itemsForUrlPolicy!(await repo.scope('bjtu', owner), url);
      assert.ok(metadata?.length);
      assert.ok(!JSON.stringify(metadata).includes('private-body-sentinel'));
      assert.ok(!JSON.stringify(metadata).includes('secret-attachment'));
    });
    await t.test('only the explicit 10000-record policy work budget causes count exhaustion', async () => {
      await sql.query("INSERT INTO campus_documents(collection,id,body) SELECT 'items','budget-' || n::text,jsonb_build_object('scope','school','schoolIds',jsonb_build_array('other'),'originalUrl','https://budget.example/' || n::text) FROM generate_series(1,10001) AS n");
      assert.equal(await repo.itemsForUrlPolicy!(await repo.scope('bjtu', owner), 'https://www.example.com/unknown'), null);
    });
    await t.test('the elapsed-time budget fails closed after a SQL metadata page without returning partial authorization', async () => {
      await sql.query("DELETE FROM campus_documents WHERE collection='items' AND id LIKE 'budget-%'");
      let elapsed = 0;
      const monotonic = performance.now.bind(performance);
      const timing = t.mock.method(performance, 'now', () => monotonic() + elapsed);
      const delayed: SqlPool = { query: sql.query.bind(sql), async connect() {
        const client = await sql.connect();
        return { release: () => client.release(), async query(statement, values) {
          const result = await client.query(statement, values);
          if (result.rows.some(value => 'metadata' in value)) elapsed = 6000;
          return result;
        } };
      } };
      try { assert.equal(await postgresRepository(delayed).itemsForUrlPolicy!(await repo.scope('bjtu', owner), 'https://www.example.com/unknown'), null); }
      finally { timing.mock.restore(); }
    });
  } finally { await pool.end(); await server.stop(); }
});
