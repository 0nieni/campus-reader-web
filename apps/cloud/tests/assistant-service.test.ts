import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureDb, identity, actor, ownerConfig } from './feature-fixture';
import { assistantService } from '../src/assistant-service';
import { aiService } from '../src/ai-service';
import { createGateway } from '../src/gateway';
import type { AiRecommendations } from '@campus/contracts';
import type { ItemRow } from '../src/repository';

function searchFixture() {
  const f = fixtureDb();
  const original = f.repo.school;
  f.repo.school = async id => ({ ...(await original(id))!, homepage: 'https://www.bjtu.edu.cn/', announcementUrl: 'https://www.bjtu.edu.cn/notices' });
  f.repo.items = async (_scope, offset, limit) => [...f.items.values()].slice(offset, offset + limit);
  return f;
}
const article = '<article>竞赛报名通知要求提交报名表，并根据学校原文核实参与资格。未提供具体截止时间，不应从搜索摘要推断。</article>';

test('external public tutorials become account-scoped evidence without posing as school announcements', async () => {
  const f = searchFixture();
  const assistant = assistantService(f.db, f.repo, aiService(f.db, f.repo), Date.now, async () => ({ state: 'complete', message: '全网搜索完成', candidates: [{ url: 'https://docs.example.org/typescript', title: 'TypeScript Promise 教程', snippet: '不能当正文' }] }), async url => ({ url, html: article }));
  const result = await assistant.handle('ai.recommend', { schoolId: 'bjtu', query: 'TypeScript Promise', search: true }, identity) as AiRecommendations;
  const found = result.items.find(item => item.title === 'TypeScript Promise 教程')!;
  assert.equal(found.allowAi, true);
  assert.equal(found.sourceName, 'docs.example.org');
  assert.equal(found.readState, 'body');
  const stored = f.rows('items').get(found.id)!;
  assert.equal(stored.ownerOpenid, identity.dataOwnerId);
  assert.deepEqual(stored.schoolIds, ['bjtu']);
  assert.ok(stored.aiSearchExpiresAt);
  assert.match(result.coverage, /全网/);
});

test('assistant gateway authenticates new actions and rejects forged owner fields', async () => {
  const f = fixtureDb(), ai = aiService(f.db, f.repo), assistant = assistantService(f.db, f.repo, ai);
  const gateway = createGateway(f.repo, ownerConfig, Date.now, { ai: { handle: (a, i, who) => assistant.supports(a) ? assistant.handle(a, i, who) : ai.handle(a, i, who) } });
  const response = await gateway({ action: 'ai.profile.get', input: { schoolId: 'bjtu' } }, actor);
  assert.equal(response.ok, true);
  assert.equal((await gateway({ action: 'ai.profile.get', input: { schoolId: 'bjtu', owner: 'someone' } }, actor)).ok, false);
});

test('unconfigured search retains local notices and makes no model calls', async () => {
  const f = fixtureDb(); let calls = 0; const old = process.env.AI_CHAT_API_KEY; delete process.env.AI_CHAT_API_KEY;
  try {
    const assistant = assistantService(f.db, f.repo, aiService(f.db, f.repo, async () => { calls++; return ''; }));
    const result = await assistant.handle('ai.recommend', { schoolId: 'bjtu', query: '竞赛', search: true }, identity) as AiRecommendations;
    assert.equal(result.search.state, 'unconfigured'); assert.ok(result.items.length); assert.equal(calls, 0);
  } finally { if (old !== undefined) process.env.AI_CHAT_API_KEY = old; }
});

test('configured search stays idle on page open without falsely claiming it is unconfigured', async () => {
  const f = fixtureDb(); const old = process.env.AI_CHAT_API_KEY; process.env.AI_CHAT_API_KEY = 'fixture-key-never-sent';
  try {
    let searches = 0;
    const assistant = assistantService(f.db, f.repo, aiService(f.db, f.repo), Date.now, async () => { searches++; throw new Error('must not search on open'); });
    const result = await assistant.handle('ai.recommend', { schoolId: 'bjtu' }, identity) as AiRecommendations;
    assert.equal(result.search.state, 'idle'); assert.equal(searches, 0);
    assert.ok(!result.search.message.includes('未配置'));
  } finally { if (old === undefined) delete process.env.AI_CHAT_API_KEY; else process.env.AI_CHAT_API_KEY = old; }
});

test('search candidates require real body evidence and are scoped, expiring, non-subscribed imports', async () => {
  const f = fixtureDb();
  const original = f.repo.school; f.repo.school = async id => ({ ...(await original(id))!, homepage: 'https://www.bjtu.edu.cn/', announcementUrl: 'https://www.bjtu.edu.cn/notices' });
  const search = async () => ({ state: 'complete' as const, message: '搜索完成', candidates: [{ url: 'https://www.bjtu.edu.cn/info/123/456.htm', title: '编程竞赛报名通知', snippet: '不能当正文的搜索摘要' }] });
  const reader = async (url: string) => ({ url, html: '<article>编程竞赛报名通知，面向在校本科生，需要准备报名表并根据学校通知核实参与条件。未提供具体截止时间。</article>' });
  const assistant = assistantService(f.db, f.repo, aiService(f.db, f.repo), Date.now, search, reader);
  const result = await assistant.handle('ai.recommend', { schoolId: 'bjtu', search: true }, identity) as AiRecommendations;
  const found = result.items.find(n => n.title === '编程竞赛报名通知')!;
  assert.equal(found.readState, 'body'); assert.equal(found.allowAi, true);
  const stored = f.rows('items').get(found.id)!; assert.equal(stored.ownerOpenid, identity.dataOwnerId); assert.equal(stored.importKind, 'website'); assert.ok(stored.aiSearchExpiresAt);
  const source = f.rows('sources').get(stored.sourceId)!; assert.notEqual(source.importKind, 'website'); assert.equal(source.autoCollect, false);
});

test('search cannot reimport a known denied URL under a new permissive source or overwrite its original body', async () => {
  const f = searchFixture(), original = structuredClone(f.items.get('notice')!);
  f.rows('sources').get('source')!.aiProcessing = 'import_only';
  let reads = 0;
  const search = async () => ({ state: 'complete' as const, message: '搜索完成', candidates: [{ url: original.originalUrl!, title: '搜索中的竞赛报名通知', snippet: '新摘要' }] });
  const assistant = assistantService(f.db, f.repo, aiService(f.db, f.repo), Date.now, search, async url => { reads++; return { url, html: article }; });
  const result = await assistant.handle('ai.recommend', { schoolId: 'bjtu', search: true }, identity) as AiRecommendations;
  assert.deepEqual(result.items.map(row => [row.id, row.allowAi]), [['notice', false]]);
  assert.equal(result.items[0].title, original.title);
  assert.equal(reads, 0);
  assert.deepEqual(f.items.get('notice'), original);
  assert.equal(f.rows('items').size, 0);
  assert.equal(f.rows('sources').size, 1);
});

test('canonical known-URL lookup includes the second page beyond the top five recommendations', async () => {
  const f = searchFixture(), known = f.items.get('notice')!;
  f.items.clear();
  const at = Date.now();
  for (let index = 0; index < 110; index++) f.items.set(`fresh_${index}`, { ...known, _id: `fresh_${index}`, originalUrl: `https://www.bjtu.edu.cn/fresh_${index}`, publishedAt: new Date(at).toISOString() });
  f.items.set('notice', { ...known, originalUrl: 'https://www.bjtu.edu.cn/info/123/456.htm#details', canonicalUrl: 'https://www.bjtu.edu.cn/info/123/456.htm', publishedAt: new Date(at - 86400000).toISOString() });
  let reads = 0;
  const search = async () => ({ state: 'complete' as const, message: '搜索完成', candidates: [{ url: 'https://www.bjtu.edu.cn/info/123/456.htm#another', title: '竞赛报名通知', snippet: '' }] });
  const assistant = assistantService(f.db, f.repo, aiService(f.db, f.repo), Date.now, search, async url => { reads++; return { url, html: article }; });
  assert.ok(!(await assistant.handle('ai.recommend', { schoolId: 'bjtu' }, identity) as AiRecommendations).items.some(row => row.id === 'notice'));
  const result = await assistant.handle('ai.recommend', { schoolId: 'bjtu', search: true }, identity) as AiRecommendations;
  assert.equal(result.items[0].id, 'notice');
  assert.equal(result.items[0].allowAi, true);
  assert.equal(reads, 0);
  assert.equal(f.rows('items').size, 0);
});

test('known notices retain restrictions from secondary sourceIds and from disabled sources', async () => {
  for (const disabled of [false, true]) {
    const f = searchFixture(), known = f.items.get('notice')!;
    known.sourceIds = ['secondary'];
    f.rows('sources').set('secondary', { _id: 'secondary', scope: 'school', schoolIds: ['bjtu'], aiProcessing: disabled ? 'allow' : 'import_only', enabled: !disabled });
    let reads = 0;
    const search = async () => ({ state: 'complete' as const, message: '搜索完成', candidates: [{ url: known.originalUrl!, title: '竞赛报名通知', snippet: '' }] });
    const assistant = assistantService(f.db, f.repo, aiService(f.db, f.repo), Date.now, search, async url => { reads++; return { url, html: article }; });
    const result = await assistant.handle('ai.recommend', { schoolId: 'bjtu', search: true }, identity) as AiRecommendations;
    assert.equal(result.items[0].id, 'notice');
    assert.equal(result.items[0].allowAi, false);
    assert.equal(reads, 0);
    assert.equal(f.rows('items').size, 0);
    assert.equal(f.rows('sources').size, 2);
  }
});

test('redirect destinations are matched against known denied URLs before saving any fetched body', async () => {
  const f = searchFixture(), known = structuredClone(f.items.get('notice')!);
  f.rows('sources').get('source')!.aiProcessing = 'import_only';
  let reads = 0;
  const search = async () => ({ state: 'complete' as const, message: '搜索完成', candidates: [{ url: 'https://www.bjtu.edu.cn/redirect', title: '竞赛报名通知', snippet: '' }] });
  const assistant = assistantService(f.db, f.repo, aiService(f.db, f.repo), Date.now, search, async () => { reads++; return { url: known.originalUrl!, html: article }; });
  const result = await assistant.handle('ai.recommend', { schoolId: 'bjtu', search: true }, identity) as AiRecommendations;
  assert.deepEqual(result.items.map(row => [row.id, row.allowAi]), [['notice', false]]);
  assert.equal(reads, 1);
  assert.deepEqual(f.items.get('notice'), known);
  assert.equal(f.rows('items').size, 0);
  assert.equal(f.rows('sources').size, 1);
});

test('known-URL lookup never exposes a private manual notice or a foreign-school row', async () => {
  const f = searchFixture(), known = f.items.get('notice')!;
  const url = known.originalUrl!;
  f.items.clear();
  const hidden: ItemRow = { ...known, _id: 'private', title: '私人材料标题不得展示', ownerOpenid: identity.dataOwnerId, scope: 'private', type: 'manual' };
  f.items.set(hidden._id, hidden);
  f.items.set('foreign', { ...known, _id: 'foreign', title: '外校材料标题不得展示', schoolIds: ['other'] });
  const search = async () => ({ state: 'complete' as const, message: '搜索完成', candidates: [{ url, title: '本校竞赛报名通知', snippet: '' }] });
  const assistant = assistantService(f.db, f.repo, aiService(f.db, f.repo), Date.now, search, async url => ({ url, html: article }));
  const result = await assistant.handle('ai.recommend', { schoolId: 'bjtu', search: true }, identity) as AiRecommendations;
  assert.ok(!result.items.some(item => item.title === '本校竞赛报名通知'), 'known inaccessible URL cannot be reimported');
  assert.ok(!JSON.stringify(result).includes('不得展示'));
  assert.ok(result.items.every(item => !['private', 'foreign'].includes(item.id)));
});

test('saturated policy coverage hides uncertain URLs while preserving real search count and actionable status', async () => {
  const f = searchFixture(), template = f.items.get('notice')!;
  f.items.clear();
  for (let index = 0; index < 10001; index++) f.items.set(`known_${index}`, { ...template, _id: `known_${index}`, originalUrl: `https://www.bjtu.edu.cn/known_${index}` });
  f.items.get('known_10000')!.aiProcessing = 'import_only';
  let reads = 0;
  const search = async () => ({ state: 'complete' as const, message: '搜索完成', candidates: [{ url: 'https://www.bjtu.edu.cn/known_10000', title: '竞赛报名通知', snippet: '待核验' }] });
  const assistant = assistantService(f.db, f.repo, aiService(f.db, f.repo), Date.now, search, async url => { reads++; return { url, html: article }; });
  const result = await assistant.handle('ai.recommend', { schoolId: 'bjtu', search: true }, identity) as AiRecommendations;
  assert.ok(!result.items.some(row => row.originalUrl === 'https://www.bjtu.edu.cn/known_10000'));
  assert.equal(result.search.state, 'complete');
  assert.equal(result.search.candidateCount, 1);
  assert.equal(result.search.readableCount, 0);
  assert.match(result.search.message, /核验/);
  assert.match(result.search.message, /已收录|管理员/);
  assert.equal(reads, 0);
  assert.equal(f.rows('items').size, 0);
  assert.equal(f.rows('sources').size, 1);
});
