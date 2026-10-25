import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchPublicWeb } from '../src/announcement-search';
import { chatSearchQuery } from '../src/chat-intent';
import { publicSearchSource, readPublicSearchPage } from '../src/public-search-page';
import { approvedSchoolUrl, extractArticle } from '../src/school-pages';
import { AppError } from '../src/errors';

const school = { id: 'bjtu', name: '北京交通大学', homepage: 'https://www.bjtu.edu.cn/' };
test('public web search keeps the explicit subject and accepts external domains without an institutional filter', async () => {
  const result = await searchPublicWeb(school, 'TypeScript Promise 教程', { apiKey: 'synthetic-search-key', fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.query, 'TypeScript Promise 教程');
    assert.equal('include_domains' in body, false);
    assert.equal('include_domains_mode' in body, false);
    return new Response(JSON.stringify({ results: [{ url: 'https://www.typescriptlang.org/docs/', title: 'TypeScript Handbook', content: 'Search hint only' }] }));
  } });
  assert.equal(result.state, 'complete');
  assert.equal(result.candidates[0]?.url, 'https://www.typescriptlang.org/docs/');
});
test('school references are expanded only when present in a public search subject', async () => {
  await searchPublicWeb(school, '本校竞赛', { apiKey: 'synthetic', fetch: async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).query, '北京交通大学竞赛');
    return new Response('{"results":[]}');
  } });
  assert.equal(chatSearchQuery('帮我联网搜索 TypeScript Promise 教程'), 'TypeScript Promise 教程');
  assert.equal(chatSearchQuery('找找本校比赛，我的邮箱 private@example.invalid'), '本校比赛');
  assert.equal(chatSearchQuery('搜索竞赛，但不要联网'), null);
  assert.equal(chatSearchQuery('搜索我的邮箱 private@example.invalid'), '通知公告 报名');
});
test('public source URLs reject local addresses and credential-bearing requests', () => {
  for (const url of ['http://example.org/a', 'https://127.0.0.1/a', 'https://metadata.internal/a', 'https://user:pass@example.org/a', 'https://example.org/a?token=secret', 'https://login.example.org/a'])
    assert.throws(() => publicSearchSource(url), url);
});
test('public body reads respect robots and reuse exact-host redirect checks before extracting text', async () => {
  const calls: string[] = [];
  const page = await readPublicSearchPage('https://docs.example.org/guide', async (url, source) => {
    calls.push(url);
    assert.equal(source.exactHost, true);
    if (url.endsWith('/robots.txt')) return { url, html: 'User-agent: *\nDisallow: /private' };
    assert.throws(() => approvedSchoolUrl('https://other.example.org/redirect', source));
    assert.throws(() => approvedSchoolUrl('https://docs.example.org/private', source));
    return { url, html: '<main>TypeScript Promise 的公开教程正文，包含足够长的内容作为合成测试资料，不把搜索摘要冒充已读取的正文。</main>' };
  }, async ms => { assert.equal(ms, 1500); });
  assert.equal(calls.length, 2);
  assert.match(extractArticle(page, publicSearchSource(page.url)), /公开教程正文/);
});
test('disallowed robots and cross-host final URLs never become model evidence', async () => {
  let articleReads = 0;
  await assert.rejects(readPublicSearchPage('https://docs.example.org/private', async url => {
    if (!url.endsWith('/robots.txt')) articleReads++;
    return { url, html: 'User-agent: *\nDisallow: /private' };
  }, async () => {}), { code: 'SOURCE_ROBOTS_BLOCKED' });
  assert.equal(articleReads, 0);
  await assert.rejects(readPublicSearchPage('https://docs.example.org/guide', async url => url.endsWith('/robots.txt')
    ? { url, html: '' } : { url: 'https://other.example.org/guide', html: '<article>other host</article>' }, async () => {}));
});
test('a missing robots file is allowed but unavailable rules fail without reading the article', async () => {
  const html = '<article>公开资料正文</article>';
  const page = await readPublicSearchPage('https://docs.example.org/guide', async url => {
    if (url.endsWith('/robots.txt')) throw new AppError('SOURCE_NOT_FOUND', 'missing');
    return { url, html };
  }, async () => {});
  assert.equal(page.html, html);
  await assert.rejects(readPublicSearchPage('https://docs.example.org/guide', async () => { throw new AppError('SOURCE_UNAVAILABLE', 'unavailable'); }, async () => {}), { code: 'SOURCE_UNAVAILABLE' });
});
