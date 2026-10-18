import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetlifyDB } from '@netlify/database-dev';
import { getDatabase } from '@netlify/database';
import { fileURLToPath } from 'node:url';
import { postgresStorage, type SqlPool } from '../src/postgres-storage';
import { postgresRepository } from '../src/postgres-repository';
import { createGateway } from '../src/gateway';
import { bookmarksService } from '../src/bookmarks';
import { aiService } from '../src/ai-service';
import { createSiteApi, createSiteAuth, type SiteAuth } from '../src/netlify-http';
import { siteWorkspace } from '../src/site-access';

test('Netlify HTTP authentication accepts invited sessions while rejecting CSRF, malformed claims and raw provider errors', async () => {
  const email = 'owner@example.test', user = { id: 'verified-owner', email };
  let current: typeof user | null = null, calls = 0;
  const auth: SiteAuth = { async user() { return current; }, async login(_email, password) { if (password !== 'fixture-password') throw new Error('secret=must-not-leak'); return current = user; }, async logout() { current = null; } };
  const api = createSiteApi({ auth, ownerEmail: () => email, async gateway() { calls++; return { ok: true, data: {} }; } });
  const login = createSiteAuth(auth, () => email);
  const req = (path: string, body: unknown, origin = 'https://campus.example') => new Request(`https://campus.example/${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await api(req('api', { action: 'session.get' }))).status, 401);
  assert.equal(calls, 0);
  assert.equal((await login(req('auth?op=login', { email, password: 'fixture-password' }, 'https://attacker.test'))).status, 403);
  const invalid = await login(req('auth?op=login', { email, password: 'wrong' }));
  assert.equal(invalid.status, 401); assert.ok(!(await invalid.text()).includes('secret='));
  assert.equal((await login(req('auth?op=login', { email, password: 'fixture-password' }))).status, 200);
  const deniedRelay = await api(req('api', { action: 'ai.relay', input: {} })); assert.equal(deniedRelay.status, 403);
  current = { id: '', email: 'other@example.test' }; assert.equal((await api(req('api', {}))).status, 401); assert.equal(calls, 0);
  current = user;
  assert.equal((await api(req('api', { action: 'session.get' }))).status, 200); assert.equal(calls, 1);
  assert.equal((await api(req('api', {}))).headers.get('cache-control'), 'no-store');
  assert.equal((await login(req('auth?op=logout', {}))).status, 200);
  assert.deepEqual(await (await login(new Request('https://campus.example/auth'))).json(), { ok: true, data: null });
});

test('real local Postgres migrations, scope, filters, bookmark transactions and AI lifecycle', async t => {
  const server = new NetlifyDB({ logger() {} });
  const connectionString = await server.start();
  const pool = getDatabase({ connectionString }).pool;
  // Netlify's local PGlite emulator has one SQL process, not independent
  // connection transactions. Serialize its driver connections; this is an
  // application integration test, not a hosted Postgres contention/load test.
  (pool as unknown as { options: { max: number } }).options.max = 1;
  const sql = pool as unknown as SqlPool, db = postgresStorage(sql), repo = postgresRepository(sql);
  const actor = { uid: 'postgres-owner', isAnonymous: false }, config = { ownerUid: actor.uid, dataOwnerId: 'netlify_owner' };
  let providerCalls = 0;
  process.env.AI_CHAT_BASE_URL = 'https://api.deepseek.com'; process.env.AI_CHAT_MODEL = 'fixture-model'; process.env.AI_CHAT_API_KEY = 'fixture-not-a-real-key'; process.env.AI_EXECUTION_MODE = 'direct';
  const ai = aiService(db, repo, async () => { providerCalls++; return '材料见 [R1](https://www.bjtu.edu.cn/test)'; });
  const gateway = createGateway(repo, config, Date.now, { bookmarks: bookmarksService(db, repo), ai });
  const call = async (action: string, input = {}) => gateway({ action, input }, actor);
  const insert = async (collection: string, id: string, body: Record<string, unknown>) => db.collection(collection).doc(id).set({ ...body, _id: id });
  try {
    await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations', import.meta.url)));
    const migrated = await sql.query("SELECT count(*) AS count FROM campus_documents WHERE collection='items'");
    assert.equal(Number(migrated.rows[0].count), 27);
    const verifiedSession = await call('session.get'); assert.ok(verifiedSession.ok); assert.equal((verifiedSession.data as any).legacyLinked, false);
    await insert('sources', 'source', { scope: 'school', schoolIds: ['bjtu'], aiProcessing: 'allow' });
    await insert('sources', 'private-source', { scope: 'private', ownerOpenid: 'someone-else' });
    const notice = { title: '活动 .* % 截止提醒', contentText: '报名资料正文，仅用于测试。', status: 'published', scope: 'school', schoolIds: ['bjtu'], sourceId: 'source', publishedAt: new Date().toISOString(), originalUrl: 'https://www.bjtu.edu.cn/test', categories: ['activity'], updatedAt: 'v1' };
    await insert('items', 'notice', notice);
    await insert('items', 'private', { ...notice, sourceId: 'private-source', ownerOpenid: 'someone-else' });
    await insert('items', 'unbound', { ...notice, sourceId: 'private-source', scope: undefined });
    await insert('items', 'old', { ...notice, publishedAt: '2000-01-01T00:00:00.000Z' });
    await call('school.select', { schoolId: 'bjtu' });
    await t.test('filters run before pagination; private and expired notices are excluded', async () => {
      const result = await call('feed.list', { schoolId: 'bjtu', keyword: '.*', categories: ['activity'], period: '7d' });
      assert.ok(result.ok); assert.deepEqual((result.data as any).items.map((row: any) => row.id), ['notice']);
      const empty = await call('feed.list', { schoolId: 'bjtu', keyword: "' OR 1=1 --" }); assert.ok(empty.ok); assert.equal((empty.data as any).items.length, 0);
      assert.equal((await call('feed.detail', { schoolId: 'bjtu', itemId: 'private' })).ok, false);
    });
    await t.test('concurrent bookmarks retain one entry and profile preferences', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => call('favorites.set', { schoolId: 'bjtu', itemId: 'notice', saved: true })));
      assert.ok(results.every(row => row.ok));
      const result = await call('favorites.list'); assert.ok(result.ok); assert.equal((result.data as any).items.length, 1);
      assert.equal(await repo.selectedSchool('netlify_owner'), 'bjtu');
    });
    await t.test('concurrent reservations cap at three and retries do not reserve twice', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call('ai.start', { schoolId: 'bjtu', itemIds: ['notice'], requestId: `postgres_request_${i}`, service: 'official', task: 'summary' })));
      assert.equal(results.filter(row => row.ok).length, 3, JSON.stringify(results));
      const status = await call('ai.status'); assert.ok(status.ok); assert.equal((status.data as any).quota.held, 3); assert.equal(providerCalls, 0);
      const done = results.find(row => row.ok) as { ok: true; data: any }; const id = done.data.id;
      let row = await call('ai.step', { taskId: id, step: 0 }); assert.ok(row.ok); assert.equal(providerCalls, 1);
      await call('ai.step', { taskId: id, step: 0 }); assert.equal(providerCalls, 1);
      row = await call('ai.step', { taskId: id, step: 1 }); assert.ok(row.ok); assert.equal((row.data as any).state, 'complete');
      const q = await call('ai.status'); assert.ok(q.ok); assert.equal((q.data as any).quota.used, 1); assert.equal((q.data as any).quota.held, 2);
      // Purging operates on the real JSON document, not an in-memory fixture.
      await db.collection('web_ai_tasks').doc(id).update({ expireAt: '2000-01-01T00:00:00.000Z' });
      assert.equal((await call('ai.task', { taskId: id })).ok, false);
      const stored = await db.collection('web_ai_tasks').doc(id).get();
      assert.equal((stored.data as any).purged, true); assert.equal((stored.data as any).docs, undefined); assert.equal((stored.data as any).question, undefined);
    });
    await t.test('independent invited accounts cannot access each other\'s preferences, bookmarks, private notices, tasks or quota', async () => {
      const owner = { id: actor.uid, email: 'owner@example.test' }, member = { id: 'member-uid', email: 'member@example.test' }, third = { id: 'third-uid', email: 'third@example.test' };
      const memberConfig = siteWorkspace(member, owner.email);
      assert.notEqual(memberConfig.dataOwnerId, 'netlify_owner');
      const requestAs = async (user: typeof owner, action: string, input = {}) => {
        const handler = createSiteApi({ auth: { async user() { return user; } }, ownerEmail: () => owner.email, async gateway(event, trusted) {
          return createGateway(repo, siteWorkspace(trusted, owner.email), Date.now, { bookmarks: bookmarksService(db, repo), ai })(event, { uid: trusted.id, isAnonymous: false });
        } });
        const response = await handler(new Request('https://campus.example/api', { method: 'POST', headers: { origin: 'https://campus.example', 'content-type': 'application/json' }, body: JSON.stringify({ action, input }) }));
        return await response.json() as any;
      };
      assert.equal((await requestAs(owner, 'session.get')).data.school.id, 'bjtu');
      assert.equal((await requestAs(member, 'session.get')).data.school, null);
      assert.equal((await requestAs(third, 'session.get')).data.school, null);
      await insert('schools', 'other', { name: 'Other school', status: 'ready' });
      await requestAs(member, 'school.select', { schoolId: 'other' });
      assert.equal(await repo.selectedSchool('netlify_owner'), 'bjtu');
      assert.equal(await repo.selectedSchool(memberConfig.dataOwnerId), 'other');
      await requestAs(member, 'school.select', { schoolId: 'bjtu' });
      const ownerFavorites = (await requestAs(owner, 'favorites.list')).data;
      assert.equal((await requestAs(member, 'favorites.list')).data.items.length, 0);
      await insert('items', 'member-notice', { ...notice });
      await requestAs(member, 'favorites.set', { schoolId: 'bjtu', itemId: 'member-notice', saved: true });
      assert.deepEqual((await requestAs(owner, 'favorites.list')).data, ownerFavorites);
      assert.deepEqual((await requestAs(member, 'favorites.list')).data.items.map((item: any) => item.itemId), ['member-notice']);
      await insert('sources', 'owner-private-source', { scope: 'private', ownerOpenid: 'netlify_owner', aiProcessing: 'allow' });
      await insert('items', 'owner-private-notice', { ...notice, scope: 'private', ownerOpenid: 'netlify_owner', sourceId: 'owner-private-source' });
      assert.equal((await requestAs(owner, 'feed.detail', { schoolId: 'bjtu', itemId: 'owner-private-notice' })).ok, true);
      assert.equal((await requestAs(member, 'feed.detail', { schoolId: 'bjtu', itemId: 'owner-private-notice' })).code, 'NOT_FOUND');
      const ownerQuota = (await requestAs(owner, 'ai.status')).data.quota;
      assert.equal((await requestAs(member, 'ai.status')).data.quota.remaining, 3);
      const ownerTask = (await sql.query("SELECT id FROM campus_documents WHERE collection='web_ai_tasks' AND body->>'owner'=$1 AND body->>'state'='ready' LIMIT 1", ['netlify_owner'])).rows[0]!.id;
      for (const [action, input] of [['ai.task', { taskId: ownerTask }], ['ai.cancel', { taskId: ownerTask }], ['ai.step', { taskId: ownerTask, step: 0 }], ['ai.resolve', { taskId: ownerTask, charged: false }]] as const) {
        assert.equal((await requestAs(member, action, input)).code, 'NOT_FOUND');
      }
      assert.equal((await requestAs(member, 'ai.status', { owner: 'netlify_owner' })).code, 'VALIDATION_FAILED');
      const memberTask = (await requestAs(member, 'ai.start', { schoolId: 'bjtu', itemIds: ['notice'], requestId: 'postgres_request_1', service: 'official', task: 'summary' })).data;
      assert.notEqual(memberTask.id, ownerTask);
      const memberTasks = (await requestAs(member, 'ai.list', { schoolId: 'bjtu' })).data.tasks;
      assert.deepEqual(memberTasks.map((task: any) => task.id), [memberTask.id]);
      assert.equal((await requestAs(owner, 'ai.task', { taskId: memberTask.id })).code, 'NOT_FOUND');
      await requestAs(member, 'ai.step', { taskId: memberTask.id, step: 0 });
      assert.equal((await requestAs(member, 'ai.step', { taskId: memberTask.id, step: 1 })).data.state, 'complete');
      assert.deepEqual((await requestAs(owner, 'ai.status')).data.quota, ownerQuota);
      assert.equal((await requestAs(member, 'ai.status')).data.quota.used, 1);
      assert.equal((await requestAs(third, 'ai.status')).data.quota.remaining, 3);
      const reservations = await Promise.all(Array.from({ length: 8 }, (_, index) => requestAs(member, 'ai.start', { schoolId: 'bjtu', itemIds: ['notice'], requestId: `member_request_${index}`, service: 'official', task: 'summary' })));
      assert.equal(reservations.filter(result => result.ok).length, 2);
      assert.equal((await requestAs(member, 'ai.status')).data.quota.remaining, 0);
      assert.deepEqual((await requestAs(owner, 'ai.status')).data.quota, ownerQuota);
    });
  } finally { await pool.end(); await server.stop(); }
});
