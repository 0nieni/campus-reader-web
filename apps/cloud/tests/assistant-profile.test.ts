import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiPreferences, AiRecommendations } from '@campus/contracts';
import { assistantProfile } from '../src/assistant-profile';
import type { ItemRow } from '../src/repository';
import { fixtureDb, identity } from './feature-fixture';

const at = Date.parse('2026-10-19T03:00:00Z');
const day = 86400000;
const other = { ...identity, uid: 'other-user', dataOwnerId: 'other-owner' };
const prefs = (changes: Partial<AiPreferences> = {}): AiPreferences & Record<string, unknown> => ({ schoolId: 'bjtu', interests: [], goals: '', learningEnabled: false, version: 0, ...changes });
function setup() {
  const f = fixtureDb();
  f.items.clear();
  f.repo.items = async (_scope, offset, limit) => [...f.items.values()].slice(offset, offset + limit);
  const add = (id: string, categories: string[] = ['school'], changes: Partial<ItemRow> = {}) => {
    const row: ItemRow = { _id: id, title: id, sourceId: 'source', scope: 'school', schoolIds: ['bjtu'], status: 'published', publishedAt: new Date(at - day).toISOString(), originalUrl: `https://www.bjtu.edu.cn/${id}`, categories, ...changes };
    f.items.set(id, row);
    return row;
  };
  let time = at;
  return { ...f, add, service: assistantProfile(f.db, f.repo, () => time), advance: (ms: number) => { time += ms; } };
}

test('preferences default to opt-out and preserve school selection, bookmarks and unrelated account fields', async () => {
  const f = setup();
  f.rows('user_profiles').get(identity.dataOwnerId)!.webBookmarks = [{ itemId: 'saved', schoolId: 'bjtu', savedAt: new Date(at).toISOString() }];
  assert.deepEqual(await f.service.handle('ai.profile.get', { schoolId: 'bjtu' }, identity), prefs());
  const result = await f.service.handle('ai.profile.save', prefs({ interests: ['竞赛', '  编程  ', '竞赛'], goals: '准备项目', learningEnabled: true }), identity);
  assert.deepEqual(result, prefs({ interests: ['竞赛', '编程'], goals: '准备项目', learningEnabled: true, version: 1 }));
  const row = f.rows('user_profiles').get(identity.dataOwnerId)!;
  assert.equal(row.selectedSchoolId, 'bjtu');
  assert.equal(row.unrelated, 'preserve');
  assert.equal(row.webBookmarks[0].itemId, 'saved');
});

test('preference versions reject concurrent overwrites and records remain owner and school scoped', async () => {
  const f = setup();
  const writes = await Promise.allSettled([
    f.service.handle('ai.profile.save', prefs({ interests: ['竞赛'] }), identity),
    f.service.handle('ai.profile.save', prefs({ interests: ['奖学金'] }), identity),
  ]);
  assert.equal(writes.filter(row => row.status === 'fulfilled').length, 1);
  const rejected = writes.find(row => row.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'PROFILE_CONFLICT');
  assert.deepEqual(await f.service.handle('ai.profile.get', { schoolId: 'bjtu' }, other), prefs());
  await f.service.handle('ai.profile.save', prefs({ interests: ['讲座'] }), other);
  assert.deepEqual((await f.service.handle('ai.profile.get', { schoolId: 'bjtu' }, other) as AiPreferences).interests, ['讲座']);
  await assert.rejects(f.service.handle('ai.profile.get', { schoolId: 'other' }, identity), { code: 'STALE_SCOPE' });
  await f.repo.selectSchool(identity.dataOwnerId, 'other');
  assert.deepEqual(await f.service.handle('ai.profile.get', { schoolId: 'other' }, identity), prefs({ schoolId: 'other' }));
  await f.repo.selectSchool(identity.dataOwnerId, 'bjtu');
  assert.equal((await f.service.handle('ai.profile.get', { schoolId: 'bjtu' }, identity) as AiPreferences).version, 1);
});

test('preference inputs reject oversized, malformed and control-character values', async () => {
  const f = setup();
  for (const input of [prefs({ interests: Array(21).fill('keyword') }), prefs({ interests: ['x'.repeat(81)] }), prefs({ interests: ['bad\u0000value'] }), prefs({ goals: 'x'.repeat(1501) }), prefs({ version: -1 }), { ...prefs(), interests: [42] }, { ...prefs(), learningEnabled: 'yes' }]) {
    await assert.rejects(f.service.handle('ai.profile.save', input, identity), { code: 'VALIDATION_FAILED' });
  }
  assert.deepEqual(await f.service.handle('ai.profile.get', { schoolId: 'bjtu' }, identity), prefs());
});

test('cold-start recommendations use publication dates, retain real URLs, and never infer a profile', async () => {
  const f = setup();
  f.add('older', ['competition']);
  f.add('newer', ['academic'], { publishedAt: new Date(at).toISOString(), contentText: 'lecture body', updatedAt: new Date(at).toISOString() });
  f.add('undated', ['school'], { publishedAt: undefined, discoveredAt: new Date(at).toISOString(), originalUrl: 'javascript:alert(1)' });
  const result = await f.service.recommend(identity.dataOwnerId, 'bjtu');
  assert.deepEqual(result.items.map(row => row.id), ['newer', 'older', 'undated']);
  assert.ok(result.items.every(row => row.reason.includes('按发布时间展示')));
  assert.equal(result.items[0].originalUrl, 'https://www.bjtu.edu.cn/newer');
  assert.equal(result.items[0].readState, 'body');
  assert.equal(result.items[0].checkedAt, new Date(at).toISOString());
  assert.equal(result.items[1].readState, 'title_only');
  assert.equal(result.items[2].originalUrl, null);
  assert.equal(result.search.state, 'unconfigured');
  assert.match(result.coverage, /已有/);
});

test('explicit interests and goals outrank learned clicks and fresh notices while reserving diversity', async () => {
  const f = setup();
  for (let i = 0; i < 6; i++) f.add(`competition_${i}`, ['competition'], { title: `编程竞赛 ${i}`, publishedAt: new Date(at - (i + 1) * day).toISOString() });
  f.add('learned', ['academic'], { publishedAt: new Date(at - 10 * day).toISOString() });
  f.add('fresh', ['school'], { publishedAt: new Date(at).toISOString() });
  await f.service.handle('ai.profile.save', prefs({ interests: ['编程'], learningEnabled: true }), identity);
  await f.service.handle('ai.behavior', { schoolId: 'bjtu', itemId: 'learned' }, identity);
  const result = await f.service.recommend(identity.dataOwnerId, 'bjtu');
  assert.equal(result.items.length, 5);
  assert.deepEqual(result.items.slice(0, 4).map(row => row.id), ['competition_0', 'competition_1', 'competition_2', 'competition_3']);
  assert.equal(result.items[4].id, 'learned');
  assert.match(result.items[0].reason, /编程/);
  assert.doesNotMatch(result.items[0].reason, /符合|报名意愿/);
  assert.match(result.items[4].reason, /近期阅读/);
  await f.service.handle('ai.profile.save', prefs({ goals: 'academic', learningEnabled: true, version: 1 }), identity);
  assert.equal((await f.service.recommend(identity.dataOwnerId, 'bjtu')).items[0].id, 'learned');
});

test('disabled behavior never records; duplicate daily opens and sixth category opens do not contribute', async () => {
  const f = setup();
  for (let i = 0; i < 6; i++) f.add(`read_${i}`, ['academic']);
  assert.deepEqual(await f.service.handle('ai.behavior', { schoolId: 'bjtu', itemId: 'read_0' }, identity), { recorded: false });
  await f.service.handle('ai.profile.save', prefs({ learningEnabled: true }), identity);
  assert.deepEqual(await f.service.handle('ai.behavior', { schoolId: 'bjtu', itemId: 'read_0' }, identity), { recorded: true });
  assert.deepEqual(await f.service.handle('ai.behavior', { schoolId: 'bjtu', itemId: 'read_0' }, identity), { recorded: false });
  for (let i = 1; i < 5; i++) assert.deepEqual(await f.service.handle('ai.behavior', { schoolId: 'bjtu', itemId: `read_${i}` }, identity), { recorded: true });
  assert.deepEqual(await f.service.handle('ai.behavior', { schoolId: 'bjtu', itemId: 'read_5' }, identity), { recorded: false });
  assert.equal((await f.service.handle('ai.profile.get', { schoolId: 'bjtu' }, identity) as AiPreferences).version, 1);
  f.advance(day);
  assert.deepEqual(await f.service.handle('ai.behavior', { schoolId: 'bjtu', itemId: 'read_0' }, identity), { recorded: true });
  await assert.rejects(f.service.handle('ai.behavior', { schoolId: 'bjtu', itemId: 'missing' }, identity), { code: 'NOT_FOUND' });
});

test('clear and disabling learning remove derived preferences without deleting bookmarks or explicit interests', async () => {
  const f = setup();
  f.add('fresh', ['school'], { publishedAt: new Date(at).toISOString() });
  f.add('learned', ['academic'], { publishedAt: new Date(at - day).toISOString() });
  await f.service.handle('ai.profile.save', prefs({ learningEnabled: true, interests: ['unmatched'] }), identity);
  await f.service.handle('ai.behavior', { schoolId: 'bjtu', itemId: 'learned' }, identity);
  assert.equal((await f.service.recommend(identity.dataOwnerId, 'bjtu')).items[0].id, 'learned');
  await f.service.handle('ai.profile.clearBehavior', { schoolId: 'bjtu' }, identity);
  assert.equal((await f.service.recommend(identity.dataOwnerId, 'bjtu')).items[0].id, 'fresh');
  await f.service.handle('ai.behavior', { schoolId: 'bjtu', itemId: 'learned' }, identity);
  await f.service.handle('ai.profile.save', prefs({ interests: ['unmatched'], version: 1 }), identity);
  await f.service.handle('ai.profile.save', prefs({ interests: ['unmatched'], learningEnabled: true, version: 2 }), identity);
  assert.equal((await f.service.recommend(identity.dataOwnerId, 'bjtu')).items[0].id, 'fresh');
  assert.deepEqual((await f.service.handle('ai.profile.get', { schoolId: 'bjtu' }, identity) as AiPreferences).interests, ['unmatched']);
});

test('behavior expires at 30 days, and each owner has independent learned interests', async () => {
  const f = setup();
  f.add('fresh', ['school'], { publishedAt: new Date(at).toISOString() });
  f.add('learned', ['academic']);
  await f.service.handle('ai.profile.save', prefs({ learningEnabled: true }), identity);
  await f.service.handle('ai.behavior', { schoolId: 'bjtu', itemId: 'learned' }, identity);
  assert.equal((await f.service.recommend(other.dataOwnerId, 'bjtu')).items[0].id, 'fresh');
  f.advance(30 * day);
  assert.equal((await f.service.recommend(identity.dataOwnerId, 'bjtu')).items[0].id, 'fresh');
});

test('dismissals hide only the specific notice for the current owner and school and can be undone', async () => {
  const f = setup();
  f.add('notice_one', ['competition']);
  f.add('notice_two', ['competition']);
  await f.service.handle('ai.dismiss', { schoolId: 'bjtu', itemId: 'notice_one', dismissed: true }, identity);
  assert.deepEqual((await f.service.recommend(identity.dataOwnerId, 'bjtu')).items.map(row => row.id), ['notice_two']);
  assert.equal((await f.service.recommend(other.dataOwnerId, 'bjtu')).items.length, 2);
  await f.service.handle('ai.dismiss', { schoolId: 'bjtu', itemId: 'notice_one', dismissed: false }, identity);
  assert.equal((await f.service.recommend(identity.dataOwnerId, 'bjtu')).items.length, 2);
});

test('automatic candidates exclude foreign, stale, withdrawn, private mail/manual, and relabeled private notices', async () => {
  const f = setup();
  f.add('okay');
  f.add('foreign', ['competition'], { schoolIds: ['other'] });
  f.add('expired', ['school'], { publishedAt: new Date(at - 366 * day).toISOString() });
  f.add('withdrawn', ['school'], { status: 'withdrawn' });
  f.add('mail', ['mail'], { ownerOpenid: identity.dataOwnerId, scope: 'private', personalCategories: ['competition'], canonicalUrl: 'mail:1' });
  f.add('manual', ['competition'], { ownerOpenid: identity.dataOwnerId, type: 'manual', canonicalUrl: 'manual:1' });
  f.add('private', ['competition'], { ownerOpenid: identity.dataOwnerId, scope: 'private' });
  assert.deepEqual((await f.service.recommend(identity.dataOwnerId, 'bjtu')).items.map(row => row.id), ['okay']);
});

test('source existence, enabled state and AI permissions are checked without fetching material', async () => {
  const f = setup();
  let fetched = 0;
  f.repo.material = async row => { fetched++; return row; };
  f.add('allow');
  f.add('blocked', ['school'], { aiProcessing: 'import_only' });
  f.add('source_blocked', ['school'], { sourceId: 'blocked_source' });
  f.add('missing_source', ['school'], { sourceId: 'missing' });
  f.add('disabled_source', ['school'], { sourceId: 'disabled' });
  f.rows('sources').set('blocked_source', { _id: 'blocked_source', aiProcessing: 'import_only', scope: 'school', schoolIds: ['bjtu'] });
  f.rows('sources').set('disabled', { _id: 'disabled', enabled: false, aiProcessing: 'allow' });
  const result = await f.service.recommend(identity.dataOwnerId, 'bjtu');
  assert.deepEqual(result.items.map(row => [row.id, row.allowAi]), [['allow', true], ['blocked', false], ['source_blocked', false]]);
  assert.equal(fetched, 0);
  assert.equal(f.rows('web_ai_tasks').size, 0);
  assert.equal(f.rows('web_ai_accounts').size, 0);
});

test('owner public website imports require the same school and owner and explicit AI permission', async () => {
  const f = setup();
  f.rows('sources').set('website_source', { _id: 'website_source', scope: 'private', schoolIds: ['bjtu'], ownerOpenid: identity.dataOwnerId, importKind: 'website', aiProcessing: 'allow', enabled: true });
  f.add('website', ['academic'], { scope: 'private', ownerOpenid: identity.dataOwnerId, importKind: 'website', sourceId: 'website_source', aiProcessing: 'allow' });
  f.add('other_website', ['academic'], { scope: 'private', ownerOpenid: other.dataOwnerId, importKind: 'website', sourceId: 'website_source', aiProcessing: 'allow' });
  f.add('other_school_website', ['academic'], { scope: 'private', ownerOpenid: identity.dataOwnerId, importKind: 'website', sourceId: 'website_source', aiProcessing: 'allow', schoolIds: ['other'] });
  const result = await f.service.recommend(identity.dataOwnerId, 'bjtu');
  assert.deepEqual(result.items.map(row => row.id), ['website']);
  assert.equal(result.items[0].allowAi, true);
  f.rows('sources').get('website_source')!.aiProcessing = 'import_only';
  assert.equal((await f.service.recommend(identity.dataOwnerId, 'bjtu')).items[0].allowAi, false);
});

test('recommendation scans are bounded and queries are validated without changing saved preferences', async () => {
  const f = setup();
  for (let i = 0; i < 220; i++) f.add(`notice_${String(i).padStart(3, '0')}`);
  const result = await f.service.handle('ai.recommend', { schoolId: 'bjtu', query: 'notice_150' }, identity) as AiRecommendations;
  assert.equal(result.items[0].id, 'notice_150');
  assert.equal(result.items.length, 5);
  assert.ok(result.items.every(row => Number(row.id.slice(7)) < 200));
  await assert.rejects(f.service.handle('ai.recommend', { schoolId: 'bjtu', query: 'x'.repeat(1501) }, identity), { code: 'VALIDATION_FAILED' });
  assert.deepEqual(await f.service.handle('ai.profile.get', { schoolId: 'bjtu' }, identity), prefs());
});

test('a broad competition label does not fabricate a programming keyword match', async () => {
  const f = setup();
  f.add('speech', ['competition'], { title: '演讲比赛', publishedAt: new Date(at).toISOString() });
  f.add('programming', ['academic'], { title: '编程讲座', publishedAt: new Date(at - day).toISOString() });
  await f.service.handle('ai.profile.save', prefs({ interests: ['编程'] }), identity);
  const result = await f.service.recommend(identity.dataOwnerId, 'bjtu');
  assert.equal(result.items[0].id, 'programming');
  assert.equal(result.items[1].reason, '按发布时间展示');
});

test('clearing behavior also stops old favorites from deriving interests while preserving the favorites themselves', async () => {
  const f = setup();
  f.add('fresh', ['school'], { publishedAt: new Date(at).toISOString() });
  f.add('saved', ['academic']);
  f.rows('user_profiles').get(identity.dataOwnerId)!.webBookmarks = [{ itemId: 'saved', schoolId: 'bjtu', savedAt: new Date(at - 1000).toISOString() }];
  await f.service.handle('ai.profile.save', prefs({ learningEnabled: true }), identity);
  assert.equal((await f.service.recommend(identity.dataOwnerId, 'bjtu')).items[0].id, 'saved');
  await f.service.handle('ai.profile.clearBehavior', { schoolId: 'bjtu' }, identity);
  assert.equal((await f.service.recommend(identity.dataOwnerId, 'bjtu')).items[0].id, 'fresh');
  assert.equal(f.rows('user_profiles').get(identity.dataOwnerId)!.webBookmarks[0].itemId, 'saved');
});

test('a public website import cannot borrow a source attached to another school', async () => {
  const f = setup();
  f.rows('sources').set('website_source', { _id: 'website_source', scope: 'private', schoolIds: ['other'], ownerOpenid: identity.dataOwnerId, importKind: 'website', aiProcessing: 'allow', enabled: true });
  f.add('website', ['academic'], { scope: 'private', ownerOpenid: identity.dataOwnerId, importKind: 'website', sourceId: 'website_source', aiProcessing: 'allow' });
  assert.equal((await f.service.recommend(identity.dataOwnerId, 'bjtu')).items.length, 0);
});

test('legacy sources without scope metadata must appear in the server-authorized source list', async () => {
  const f = setup();
  f.rows('sources').set('unscoped_source', { _id: 'unscoped_source', aiProcessing: 'allow' });
  f.add('unscoped_notice', ['school'], { sourceId: 'unscoped_source' });
  f.add('authorized_notice');
  assert.deepEqual((await f.service.recommend(identity.dataOwnerId, 'bjtu')).items.map(row => row.id), ['authorized_notice']);
});
