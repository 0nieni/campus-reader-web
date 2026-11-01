import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import type { ChatReference } from '@campus/contracts';
import type { Database } from '../src/storage';
import { fixtureDb, identity } from './feature-fixture';
import { filterProgramReferences } from '../src/program-references';

const owner = identity.dataOwnerId;
const ref: ChatReference = { reference: 'R1', itemId: 'notice', title: '测试竞赛', originalUrl: 'https://www.bjtu.edu.cn/test' };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const searchSourceId = 'ai_search_' + hash([owner, 'bjtu']);
const snippet = (url = 'https://www.bjtu.edu.cn/new'): ChatReference => ({ reference: 'R2', itemId: 'ai_search_item_' + hash([owner, 'bjtu', url]), title: '新竞赛报名通知', originalUrl: url });

function fixture() {
  const f = fixtureDb(), school = f.repo.school;
  f.repo.school = async id => ({ ...(await school(id))!, homepage: 'https://www.bjtu.edu.cn/', announcementUrl: 'https://www.bjtu.edu.cn/notices' });
  f.repo.items = async (_scope, offset, limit) => [...f.items.values()].slice(offset, offset + limit);
  return { ...f, filter: (refs: ChatReference[] = [ref]) => filterProgramReferences(f.db, f.repo, owner, 'bjtu', refs, 'school') };
}

test('program references retain currently accessible exact titles and original links', async () => {
  assert.deepEqual(await fixture().filter(), [ref]);
});

test('program references disappear when a current source is disabled, deleted, removed or foreign', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.rows('sources').get('source')!.enabled = false; },
    (f: ReturnType<typeof fixture>) => { f.rows('sources').get('source')!.deleted = true; },
    (f: ReturnType<typeof fixture>) => { f.rows('sources').delete('source'); },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.rows('sources').get('source')!, { scope: 'private', ownerOpenid: 'foreign' }); },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.rows('sources').get('source')!, { scope: 'school', schoolIds: ['other'] }); },
  ]) {
    const f = fixture(); change(f);
    assert.deepEqual(await f.filter(), []);
  }
});

test('all secondary source policies apply to saved program references', async () => {
  const f = fixture();
  f.items.get('notice')!.sourceIds = ['secondary'];
  f.rows('sources').set('secondary', { _id: 'secondary', scope: 'school', schoolIds: ['bjtu'], enabled: false });
  assert.deepEqual(await f.filter(), []);
});

test('import-only AI policy retains the accessible original link without requiring body access', async () => {
  const f = fixture();
  f.items.get('notice')!.aiProcessing = 'import_only';
  f.items.get('notice')!.contentText = '';
  f.rows('sources').get('source')!.aiProcessing = 'import_only';
  f.repo.material = async () => { throw new Error('original links must not read body'); };
  assert.deepEqual(await f.filter(), [ref]);
});

test('foreign accounts, foreign schools, withdrawn, deleted and expired items lose references', async () => {
  const patches: Record<string, unknown>[] = [
    { ownerOpenid: 'foreign', scope: 'private' }, { schoolIds: ['other'] },
    { status: 'withdrawn' }, { deleted: true }, { publishedAt: '2000-01-01T00:00:00.000Z' },
    { aiSearchExpiresAt: '2000-01-01T00:00:00.000Z' },
    { aiSearchExpiresAt: 'not-a-date' },
  ];
  for (const patch of patches) {
    const f = fixture(); Object.assign(f.items.get('notice')!, patch);
    assert.deepEqual(await f.filter(), [], JSON.stringify(patch));
  }
  const f = fixture(); f.items.delete('notice');
  assert.deepEqual(await f.filter(), []);
});

test('changed current titles and URLs never republish the old saved snapshot', async () => {
  for (const patch of [{ title: '更新后标题' }, { originalUrl: 'https://www.bjtu.edu.cn/changed' }]) {
    const f = fixture(); Object.assign(f.items.get('notice')!, patch);
    assert.deepEqual(await f.filter(), []);
  }
});

test('DB-backed temporary search items remain accessible when repo.item has no DB fallback', async () => {
  const f = fixture(), candidate = snippet();
  f.rows('sources').set(searchSourceId, { _id: searchSourceId, scope: 'private', ownerOpenid: owner, schoolIds: ['bjtu'], type: 'ai_search', autoCollect: false, aiProcessing: 'allow' });
  f.rows('items').set(candidate.itemId, { _id: candidate.itemId, title: candidate.title, originalUrl: candidate.originalUrl, status: 'published', scope: 'private', ownerOpenid: owner, schoolIds: ['bjtu'], importKind: 'website', sourceId: searchSourceId, createdAt: new Date().toISOString(), aiSearchExpiresAt: new Date(Date.now() + 60000).toISOString() });
  assert.deepEqual(await f.filter([candidate]), [candidate]);
  f.rows('items').get(candidate.itemId)!.status = 'withdrawn';
  assert.deepEqual(await f.filter([candidate]), []);
});

test('new snippet-only references retain verified official links without a stored item or remote read', async () => {
  const f = fixture(), candidate = snippet();
  f.repo.material = async () => { throw new Error('must not read body'); };
  assert.deepEqual(await f.filter([candidate]), [candidate]);
});

test('forged snippet identities, off-domain, credentialed and login URLs are removed', async () => {
  const f = fixture();
  for (const candidate of [
    { ...snippet(), itemId: 'ai_search_item_forged' },
    { ...snippet(), itemId: 'ai_search_item_' + hash(['foreign', 'bjtu', snippet().originalUrl]) },
    snippet('https://attacker.example/notices'), snippet('https://user:password@www.bjtu.edu.cn/test'),
    snippet('https://sso.bjtu.edu.cn/notices'),
  ]) assert.deepEqual(await f.filter([candidate]), []);
});

test('the current school catalog controls acceptance of previously official snippet URLs', async () => {
  const f = fixture();
  f.repo.school = async () => ({ id: 'bjtu', name: '学校', status: 'ready', homepage: 'https://other.edu.cn/', announcementUrl: 'https://other.edu.cn/notices' });
  assert.deepEqual(await f.filter([snippet()]), []);
});

test('disabled, deleted, foreign-owner and foreign-school virtual search sources revoke snippets', async () => {
  for (const patch of [{ enabled: false }, { deleted: true }, { ownerOpenid: 'foreign' }, { schoolIds: ['other'] }]) {
    const f = fixture();
    f.rows('sources').set(searchSourceId, { _id: searchSourceId, scope: 'private', ownerOpenid: owner, schoolIds: ['bjtu'], type: 'ai_search', autoCollect: false, ...patch });
    assert.deepEqual(await f.filter([snippet()]), []);
  }
});

test('virtual import-only policy does not hide a user-visible snippet original link', async () => {
  const f = fixture();
  f.rows('sources').set(searchSourceId, { _id: searchSourceId, scope: 'private', ownerOpenid: owner, schoolIds: ['bjtu'], type: 'ai_search', autoCollect: false, aiProcessing: 'import_only' });
  assert.deepEqual(await f.filter([snippet()]), [snippet()]);
});

test('an unstored snippet cannot route around a known same-URL source revocation', async () => {
  for (const patch of [{ enabled: false }, { deleted: true }, { ownerOpenid: 'foreign', scope: 'private' }]) {
    const f = fixture();
    f.items.get('notice')!.originalUrl = snippet().originalUrl!;
    f.items.get('notice')!.title = snippet().title;
    Object.assign(f.rows('sources').get('source')!, patch);
    assert.deepEqual(await f.filter([snippet()]), []);
  }
});

test('known same-URL policy lookup finds changed titles beyond the feed page', async () => {
  const f = fixture(), template = f.items.get('notice')!;
  f.items.clear();
  for (let index = 0; index < 110; index++) f.items.set('row_' + index, { ...template, _id: 'row_' + index, originalUrl: 'https://www.bjtu.edu.cn/old/' + index });
  f.items.set('known', { ...template, _id: 'known', originalUrl: snippet().originalUrl!, title: '当前新标题' });
  assert.deepEqual(await f.filter([snippet()]), []);
});

test('exhausted URL metadata work budget drops uncertain links without scanning feed pages', async () => {
  const f = fixture(), template = f.items.get('notice')!;
  f.items.clear();
  for (let index = 0; index < 10001; index++) f.items.set('row_' + index, { ...template, _id: 'row_' + index, originalUrl: snippet().originalUrl! });
  f.repo.items = async () => { throw new Error('must not scan feed'); };
  assert.deepEqual(await f.filter([snippet()]), []);
});

test('repositories without a controlled URL policy lookup fail closed for unstored snippets', async () => {
  const f = fixture(); delete f.repo.itemsForUrlPolicy;
  assert.deepEqual(await f.filter([snippet()]), []);
});

test('reference output is capped at five and does not fetch unbounded extra references', async () => {
  const f = fixture(); let reads = 0;
  const read = f.repo.item;
  f.repo.item = async id => { reads++; return read(id); };
  const refs = Array.from({ length: 7 }, (_, index) => ({ ...ref, reference: 'R' + (index + 1) }));
  assert.equal((await f.filter(refs)).length, 5);
  assert.ok(reads <= 5);
});

test('school changes during validation fail closed before returning links', async () => {
  const f = fixture(), read = f.repo.item;
  f.repo.item = async id => { await f.repo.selectSchool(owner, 'other'); return read(id); };
  await assert.rejects(f.filter(), { code: 'STALE_SCOPE' });
});

test('database failure hides links without exposing raw upstream errors', async () => {
  const f = fixture();
  const db = { collection() { throw new Error('secret-fixture-upstream-error'); } } as unknown as Database;
  assert.deepEqual(await filterProgramReferences(db, f.repo, owner, 'bjtu', [ref]), []);
});

test('default web mode preserves a verified public external snippet without a body read', async () => {
  const f = fixture(), candidate = snippet('https://www.example.com/public/competition');
  f.repo.material = async () => { throw new Error('no external body read permitted'); };
  assert.deepEqual(await filterProgramReferences(f.db, f.repo, owner, 'bjtu', [candidate]), [candidate]);
  assert.deepEqual(await f.filter([candidate]), []);
});

test('public external snippets still obey virtual source and known same-URL revocation', async () => {
  const candidate = snippet('https://www.example.com/public/competition');
  const f = fixture();
  const run = () => filterProgramReferences(f.db, f.repo, owner, 'bjtu', [candidate]);
  assert.deepEqual(await run(), [candidate]);
  f.rows('sources').set(searchSourceId, { _id: searchSourceId, scope: 'private', ownerOpenid: owner, schoolIds: ['bjtu'], type: 'ai_search', autoCollect: false, aiProcessing: 'import_only' });
  assert.deepEqual(await run(), [candidate]);
  f.rows('sources').get(searchSourceId)!.enabled = false;
  assert.deepEqual(await run(), []);
  f.rows('sources').delete(searchSourceId);
  Object.assign(f.items.get('notice')!, { originalUrl: candidate.originalUrl, title: candidate.title });
  assert.deepEqual(await run(), [candidate]);
  f.rows('sources').get('source')!.deleted = true;
  assert.deepEqual(await run(), []);
});

test('public external snippets preserve current owner and school boundaries', async () => {
  const candidate = snippet('https://www.example.com/public/competition');
  for (const patch of [{ ownerOpenid: 'foreign' }, { schoolIds: ['other'] }]) {
    const f = fixture();
    f.rows('sources').set(searchSourceId, { _id: searchSourceId, scope: 'private', ownerOpenid: owner, schoolIds: ['bjtu'], type: 'ai_search', autoCollect: false, ...patch });
    assert.deepEqual(await filterProgramReferences(f.db, f.repo, owner, 'bjtu', [candidate]), []);
  }
  const f = fixture();
  assert.deepEqual(await filterProgramReferences(f.db, f.repo, 'foreign', 'bjtu', [candidate]), []);
});

test('default web mode rejects hostile, login, private and credential-bearing URLs', async () => {
  const f = fixture();
  for (const url of [
    'http://www.example.com/public', 'https://login.example.com/public', 'https://sso.example.com/public',
    'https://metadata.example.com/public', 'https://localhost/public', 'https://intranet.internal/public',
    'https://127.0.0.1/public', 'https://192.168.0.1/public', 'https://[::1]/public',
    'https://user:password@www.example.com/public', 'https://www.example.com:8443/public',
    'https://www.example.com/public?api_key=hidden', 'https://www.example.com/public?session=hidden',
  ]) assert.deepEqual(await filterProgramReferences(f.db, f.repo, owner, 'bjtu', [snippet(url)]), [], url);
});
