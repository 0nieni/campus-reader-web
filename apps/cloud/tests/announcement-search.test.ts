import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchAnnouncements } from '../src/announcement-search';

const school = { id: 'school_test', name: '示例大学', homepage: 'https://example.edu.cn/', announcementUrl: 'https://notice.example.edu.cn/notices' };
const apiKey = 'tvly-test-secret-do-not-expose';
const response = (results: unknown[]) => new Response(JSON.stringify({ query: 'example', response_time: 0.1, results }), { headers: { 'content-type': 'application/json' } });

test('an absent key explicitly disables search without contacting the network', async () => {
  let calls = 0;
  const result = await searchAnnouncements(school, '竞赛', { apiKey: '', fetch: async () => { calls++; throw new Error('must not fetch'); } });
  assert.equal(result.state, 'unconfigured');
  assert.deepEqual(result.candidates, []);
  assert.match(result.message, /未配置/);
  assert.equal(calls, 0);
});

test('the fixed search endpoint receives only the scoped query and bearer credential', async () => {
  let calls = 0;
  const result = await searchAnnouncements(school, '  竞赛报名  ', { apiKey, fetch: async (input, init) => {
    calls++;
    assert.equal(String(input), 'https://api.tavily.com/search');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${apiKey}`);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.query, '示例大学 竞赛报名');
    assert.deepEqual(body.include_domains, ['example.edu.cn']);
    assert.equal(body.search_depth, 'basic');
    assert.equal(body.max_results, 5);
    assert.equal(body.include_answer, false);
    assert.equal(body.include_raw_content, false);
    assert.ok(!String(init?.body).includes(apiKey));
    assert.ok(init?.signal instanceof AbortSignal);
    return response([{ url: 'https://notice.example.edu.cn/1#section', title: '竞赛报名', content: '搜索摘要，不是已读取正文', score: 0.9 }]);
  } });
  assert.equal(calls, 1);
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.candidates, [{ url: 'https://notice.example.edu.cn/1', title: '竞赛报名', snippet: '搜索摘要，不是已读取正文' }]);
  assert.ok(!JSON.stringify(result).includes(apiKey));
});

test('candidates reject hostile URL forms and keep only true official subdomains once', async () => {
  const urls = [
    'https://example.edu.cn.evil.test/1', 'https://evilexample.edu.cn/1', 'https://evil.test/1',
    'http://example.edu.cn/1', 'javascript:alert(1)', 'file:///etc/passwd', '//example.edu.cn/1',
    'https://user:pass@example.edu.cn/1', 'https://example.edu.cn@evil.test/1',
    'https://example.edu.cn:8443/1', 'https://example.edu.cn:443/1',
    'https://127.0.0.1/1', 'https://2130706433/1', 'https://[::1]/1',
    'https://webvpn.example.edu.cn/1', 'https://vpn.example.edu.cn/1',
    'https://sso.example.edu.cn/1', 'https://cas.example.edu.cn/1',
    'https://auth.example.edu.cn/1', 'https://login.example.edu.cn/1',
    'https://example.edu.cn./1', 'https://example.edu.cn/{{id}}',
    'https://EXAMPLE.edu.cn/real#one', 'https://example.edu.cn/real#two',
    'https://dept.example.edu.cn/subpage', 'https://notice.example.edu.cn/other',
  ];
  const result = await searchAnnouncements(school, '竞赛', { apiKey, fetch: async () => response(urls.map(url => ({ url, title: '公开通知', content: '候选摘要', score: 0.5 }))) });
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.candidates.map(item => item.url), ['https://example.edu.cn/real', 'https://dept.example.edu.cn/subpage', 'https://notice.example.edu.cn/other']);
});

test('unsafe configured hosts fail before any network request', async () => {
  const hosts = ['http://example.edu.cn', 'https://user:pass@example.edu.cn', 'https://example.edu.cn:443', 'https://127.1', 'https://[::1]', 'https://vpn.example.edu.cn', 'https://login.example.edu.cn', 'not a URL'];
  for (const homepage of hosts) {
    let calls = 0;
    const result = await searchAnnouncements({ id: 'test', name: '示例大学', homepage }, '通知', { apiKey, fetch: async () => { calls++; return response([]); } });
    assert.equal(result.state, 'failed', homepage);
    assert.equal(calls, 0, homepage);
  }
});

test('queries and result fields are bounded and search never returns more than five candidates', async () => {
  const result = await searchAnnouncements(school, '竞赛'.repeat(500), { apiKey, fetch: async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.query.length, 500);
    assert.match(body.query, /^示例大学 /);
    assert.equal(body.include_domains_mode, 'restrict');
    assert.equal(body.auto_parameters, false);
    return response([null, { url: 'https://example.edu.cn/bad', title: 3 }, ...Array.from({ length: 9 }, (_, index) => ({ url: `https://example.edu.cn/${index}`, title: '题'.repeat(1000), content: '摘'.repeat(8000), raw_content: 'must not be returned' }))]);
  } });
  assert.equal(result.candidates.length, 5);
  assert.ok(result.candidates.every(item => item.title.length <= 220 && item.snippet.length <= 2000 && !('raw_content' in item)));
});

test('trusted edu.cn hosts scope search to their institutional parent across departments', async () => {
  const result = await searchAnnouncements({ id: 'test', name: '示例大学', homepage: 'https://www.example.edu.cn/' }, '', { apiKey, fetch: async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)).include_domains, ['example.edu.cn']);
    return response([
    { url: 'https://example.edu.cn/1', title: 'institution', content: '' },
    { url: 'https://dean.example.edu.cn/1', title: 'department', content: '' },
    { url: 'https://www.example.edu.cn/1', title: 'approved', content: '' },
    { url: 'https://another.edu.cn/1', title: 'another university', content: '' },
    { url: 'https://example.edu.cn.evil.test/1', title: 'hostile suffix', content: '' },
  ]); } });
  assert.deepEqual(result.candidates.map(item => item.title), ['institution', 'department', 'approved']);
});

test('institutional expansion applies only to edu.cn without guessing other public suffixes', async () => {
  for (const homepage of ['https://www.example.com', 'https://dept.example.cn', 'https://edu.cn']) {
    const host = new URL(homepage).hostname;
    const result = await searchAnnouncements({ id: 'test', name: '示例大学', homepage }, '', { apiKey, fetch: async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)).include_domains, [host]);
      return response([{ url: `https://${host}/1`, title: 'approved', content: '' }, { url: 'https://example.com/1', title: 'untrusted parent', content: '' }]);
    } });
    assert.deepEqual(result.candidates.map(item => item.title), ['approved']);
  }
});

test('an empty successful search is distinct from network, HTTP and malformed responses', async () => {
  const empty = await searchAnnouncements(school, '通知', { apiKey, fetch: async () => response([]) });
  assert.equal(empty.state, 'complete');
  assert.deepEqual(empty.candidates, []);
  const failures: (typeof fetch)[] = [
    async () => { throw new Error(`Private upstream failure ${apiKey}`); },
    async () => new Response(`Private response ${apiKey}`, { status: 401 }),
    async () => new Response('redirect', { status: 302, headers: { location: 'https://evil.test' } }),
    async () => new Response(`not json ${apiKey}`),
    async () => new Response(JSON.stringify({ detail: `Private response ${apiKey}` })),
    async () => new Response(JSON.stringify({ results: 'wrong shape' })),
    async () => new Response('null'),
  ];
  for (const fetch of failures) {
    const result = await searchAnnouncements(school, '通知', { apiKey, fetch });
    assert.equal(result.state, 'failed');
    assert.deepEqual(result.candidates, []);
    assert.ok(!JSON.stringify(result).includes(apiKey));
    assert.ok(!JSON.stringify(result).includes('Private'));
  }
});

test('oversize declared and streaming responses fail without returning partial results', async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const largeStream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode('{"results":[')); controller.enqueue(new Uint8Array(512 * 1024)); },
    cancel() { cancelled = true; },
  });
  const streamed = await searchAnnouncements(school, '通知', { apiKey, fetch: async () => new Response(largeStream) });
  assert.equal(streamed.state, 'failed');
  assert.equal(cancelled, true);
  const declared = await searchAnnouncements(school, '通知', { apiKey, fetch: async () => new Response('{"results":[]}', { headers: { 'content-length': '524289' } }) });
  assert.equal(declared.state, 'failed');
});

test('search aborts at eight seconds and does not expose timeout details', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  const pending = searchAnnouncements(school, '通知', { apiKey, fetch: async (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  } });
  context.mock.timers.tick(7999);
  assert.equal(signal?.aborted, false);
  context.mock.timers.tick(1);
  const result = await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.candidates, []);
});

test('the deadline also cancels a stalled streaming response body', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = searchAnnouncements(school, '通知', { apiKey, fetch: async () => new Response(body) });
  await Promise.resolve();
  context.mock.timers.tick(8000);
  assert.equal((await pending).state, 'failed');
  assert.equal(cancelled, true);
});

test('the backend environment key is used when no override is supplied', async () => {
  const previous = process.env.TAVILY_API_KEY;
  try {
    process.env.TAVILY_API_KEY = apiKey;
    const result = await searchAnnouncements(school, '通知', { fetch: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${apiKey}`);
      return response([]);
    } });
    assert.equal(result.state, 'complete');
  } finally {
    if (previous === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previous;
  }
});
