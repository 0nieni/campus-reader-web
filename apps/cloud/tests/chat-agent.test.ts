import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiChatTurn, AiConversation } from '@campus/contracts';
import { fixtureDb, identity } from './feature-fixture';
import { aiService } from '../src/ai-service';
import { assistantService } from '../src/assistant-service';
import { agentContent } from '../src/chat-agent';
import { CHAT_READING_GUIDE } from '../src/chat-guide';
const url = 'https://example.org/typescript';
const searchCall = { id: 'search_1', name: 'web_search_deepseek', arguments: { query: 'TypeScript 教程' } };
const readCall = { id: 'read_1', name: 'deepseek_fetch_web_page', arguments: { url } };

function setup(respond?: (index: number, options: any) => Promise<any>, search?: any) {
  const f = fixtureDb(); f.items.clear();
  Object.assign(process.env, { AI_CHAT_BASE_URL: 'https://api.deepseek.com', AI_CHAT_API_KEY: 'fixture-key', AI_CHAT_MODEL: 'fixture-model', AI_EXECUTION_MODE: 'direct' });
  const item = f.repo.item;
  f.repo.item = async id => await item(id) || f.rows('items').get(id) as any || null;
  const requests: any[] = [], reads: string[] = [], searches: string[] = [];
  const ai = (aiService as any)(f.db, f.repo, async () => 'A公告笔记。[R1](https://www.bjtu.edu.cn/test)', Date.now, undefined, undefined, async (_c: any, _g: string, _text: string, _max: number, _e: any, options: any) => {
    const index = requests.length; requests.push(structuredClone(options));
    return respond ? respond(index, options) : index === 0 ? { text: '', calls: [searchCall] } : index === 1 ? { text: '', calls: [readCall] } : { text: `这是读到的教程。[R1](${url})`, calls: [] };
  });
  const assistant = assistantService(f.db, f.repo, ai, Date.now, async (_school, query) => {
    searches.push(query);
    return search ? search(query) : { state: 'complete', message: '已搜索', candidates: [{ title: 'TypeScript 教程', url, snippet: 'not evidence' }] };
  }, async value => { reads.push(value); return { url: value, html: '<main><article>这是实际读取到的 TypeScript 教程正文，介绍类型与接口。本文长度足够通过现有网页正文提取检查。</article></main>' }; });
  const call = (action: string, input: any) => assistant.handle(action, input, identity);
  const create = async () => await call('ai.chat.create', { schoolId: 'bjtu', requestId: 'agent-conversation-0001' }) as AiConversation;
  const send = async (id: string, question = '介绍最新 TypeScript 教程') => await call('ai.chat.send', { conversationId: id, requestId: 'agent-turn-request-001', question }) as AiChatTurn;
  const step = async (id: string, turn: AiChatTurn) => await call('ai.chat.step', { conversationId: id, turnId: turn.id, step: turn.step }) as AiChatTurn;
  return { ...f, ai, call, create, send, step, requests, reads, searches };
}

test('no selected notice can run model search → chosen read → cited answer, with one external action per step and one quota charge', async () => {
  const f = setup(), c = await f.create(); let turn = await f.send(c.id);
  assert.equal(turn.state, 'ready', 'empty selection must reach the model tool decision');
  assert.equal(f.requests.length, 0); assert.equal(f.searches.length, 0);
  turn = await f.step(c.id, turn);
  assert.equal(f.requests.length, 1); assert.equal(f.searches.length, 0);
  const searchStep = turn;
  turn = await f.step(c.id, turn);
  assert.equal(f.searches.length, 1); assert.equal(f.reads.length, 0);
  await f.step(c.id, searchStep);
  assert.equal(f.searches.length, 1, 'old step cannot replay search');
  turn = await f.step(c.id, turn);
  assert.equal(f.requests.length, 2); assert.equal(f.reads.length, 0);
  turn = await f.step(c.id, turn);
  assert.deepEqual(f.reads, [url]); assert.equal(turn.search?.readableCount, 1);
  assert.equal(turn.references[0].originalUrl, url);
  turn = await f.step(c.id, turn);
  assert.equal(turn.state, 'complete'); assert.match(turn.result!, /R1/);
  assert.equal(f.requests.length, 3);
  assert.match(f.requests[2].exchanges[1].results[0], /实际读取到的/);
  const quota = (await f.ai.handle('ai.status', {}, identity)).quota;
  assert.equal(quota.used, 1); assert.equal(quota.held, 0);
  const platform = [...f.rows('web_ai_accounts').values()].find(row => row._id.startsWith('platform-'))!;
  assert.equal(platform.attempts, 3);
});

test('ordinary reply may finish without searching and no-network questions do not expose tools', async () => {
  const f = setup(async (_i, options) => { assert.equal(options.enabled, false); return { text: '你好，可以一起阅读。', calls: [] }; });
  const c = await f.create(); let turn = await f.send(c.id, '不要联网，打个招呼');
  turn = await f.step(c.id, turn);
  assert.equal(turn.state, 'complete'); assert.equal(f.searches.length, 0); assert.equal(f.reads.length, 0);
  assert.deepEqual(turn.references, []);
});

test('a model-invented URL and private query never reach the network', async () => {
  const f = setup(async index => index === 0 ? { text: '', calls: [{ ...readCall, arguments: { url: 'https://127.0.0.1/admin' } }, { ...searchCall, arguments: { query: '我的秘密公司' } }] } : { text: '没有取得可核实资料。', calls: [] });
  const c = await f.create(); let turn = await f.send(c.id);
  for (let i = 0; i < 6 && turn.state === 'ready'; i++) turn = await f.step(c.id, turn);
  assert.equal(f.searches.length, 0); assert.equal(f.reads.length, 0);
  assert.equal(turn.state, 'complete'); assert.match(f.requests.at(-1).exchanges[0].results.join(' '), /公开|候选/);
});

test('cancel during a slow search discards its late result and never resumes the tool loop', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = setup(undefined, async () => { await gate; return { state: 'complete', message: 'done', candidates: [{ title: '教程', url }] }; });
  const c = await f.create(); let turn = await f.send(c.id);
  turn = await f.step(c.id, turn);
  const pending = f.step(c.id, turn);
  while (!f.searches.length) await new Promise(resolve => setImmediate(resolve));
  const cancelled = await f.call('ai.chat.cancel', { conversationId: c.id, turnId: turn.id }) as AiChatTurn;
  assert.equal(cancelled.state, 'cancelled'); release();
  const late = await pending;
  assert.equal(late.state, 'cancelled'); assert.equal(late.result, null); assert.equal(f.requests.length, 1);
});

test('source revocation after a tool read hides evidence and blocks the final model call', async () => {
  const f = setup(), c = await f.create(); let turn = await f.send(c.id);
  for (let i = 0; i < 4; i++) turn = await f.step(c.id, turn);
  const source = [...f.rows('sources').values()].find(row => row.type === 'ai_search')!;
  source.aiProcessing = 'import_only';
  await assert.rejects(f.step(c.id, turn), { code: 'AI_POLICY_BLOCKED' });
  assert.equal(f.requests.length, 2);
  const view = await f.call('ai.chat.get', { conversationId: c.id }) as AiConversation;
  assert.equal(view.turns[0].result, null); assert.deepEqual(view.turns[0].references, []);
});

test('search failure remains visible instead of accepting a fabricated cited answer', async () => {
  const f = setup(async index => index === 0 ? { text: '', calls: [searchCall] } : { text: '没有读到正文。', calls: [] }, async () => ({ state: 'failed', code: 'quota', message: '搜索余额不足', candidates: [] }));
  const c = await f.create(); let turn = await f.send(c.id);
  for (let i = 0; i < 4 && turn.state === 'ready'; i++) turn = await f.step(c.id, turn);
  assert.equal(turn.state, 'complete'); assert.equal(turn.search?.code, 'quota');
  assert.match(turn.result!, /余额不足/); assert.deepEqual(turn.references, []);
});

test('the fourth tool-stage model request must finish without tools and no search limit is bypassed', async () => {
  const f = setup(async (index, options) => index < 3 ? { text: '', calls: [{ ...searchCall, id: `search_${index}` }] } : (assert.equal(options.enabled, false), { text: '没有取得正文。', calls: [] }));
  const c = await f.create(); let turn = await f.send(c.id);
  for (let i = 0; i < 12 && turn.state === 'ready'; i++) turn = await f.step(c.id, turn);
  assert.equal(turn.state, 'complete'); assert.equal(f.requests.length, 4);
  assert.equal(f.searches.length, 1, 'the second search is throttled and the third exceeds the per-turn limit');
  assert.equal((await f.ai.handle('ai.status', {}, identity)).quota.used, 1);
});

test('uncertain model requests are paused with their quota hold and never automatically replayed', async () => {
  const f = setup(async () => { throw Object.assign(new Error('timeout'), { code: 'MODEL_UNCERTAIN' }); });
  const c = await f.create(); let turn = await f.send(c.id);
  turn = await f.step(c.id, turn);
  assert.equal(turn.state, 'uncertain'); assert.equal(turn.quotaHeld, true);
  await f.step(c.id, turn); assert.equal(f.requests.length, 1);
});

test('the answer request fits the combined guide/content/tool budget even after three long page reads', () => {
  const docs = Array.from({ length: 8 }, (_, i) => ({ reference: `R${i + 1}`, title: '公开资料标题'.repeat(20), originalUrl: `https://example.org/${i}/` + 'a'.repeat(200), itemId: `doc${i}`, markdown: '正文'.repeat(1000), version: '1', schoolId: 'bjtu' }));
  const task = { schoolId: 'bjtu', question: '公开问题'.repeat(320), docs, notes: ['笔记'.repeat(1100)], chat: { history: '历史'.repeat(700), summary: '摘要'.repeat(200), memory: { enabled: false, generation: 0, items: [] }, expireAt: new Date(Date.now() + 86400000).toISOString() } };
  const exchangeSize = 8982;
  const maxContent = 22000 - CHAT_READING_GUIDE.length - exchangeSize - 128;
  const content = (agentContent as any)(task, '北京交通大学', Date.now(), maxContent);
  assert.ok(CHAT_READING_GUIDE.length + content.length + exchangeSize <= 22000);
  assert.ok(content.includes(task.question), 'the current question must remain complete');
  assert.match(content, /截断|缩短/);
});

test('a followup uses the latest automatically-read document rather than an older explicitly selected notice', async () => {
  const f = setup(async index => index === 0 ? { text: 'A公告信息。[R1](https://www.bjtu.edu.cn/test)', calls: [] }
    : index === 1 ? { text: '', calls: [searchCall] } : index === 2 ? { text: '', calls: [readCall] } : { text: `B教程内容。[R1](${url})`, calls: [] });
  f.items.set('notice', { _id: 'notice', title: '旧公告A', contentText: '旧公告A的报名说明，不是新的教程内容。', sourceId: 'source', scope: 'school', schoolIds: ['bjtu'], status: 'published', publishedAt: new Date().toISOString(), originalUrl: 'https://www.bjtu.edu.cn/test', updatedAt: 'v1' });
  const c = await f.create();
  let a = await f.call('ai.chat.send', { conversationId: c.id, requestId: 'older-explicit-turn-1', question: '介绍公告A', itemIds: ['notice'] }) as AiChatTurn;
  while (a.state === 'ready') a = await f.step(c.id, a);
  assert.equal(a.state, 'complete');
  let b = await f.send(c.id);
  while (b.state === 'ready') b = await f.step(c.id, b);
  assert.equal(b.references[0].originalUrl, url);
  const follow = await f.call('ai.chat.send', { conversationId: c.id, requestId: 'followup-latest-web-1', question: '它的截止时间是什么' }) as AiChatTurn;
  assert.equal(follow.references[0].originalUrl, url);
});

test('a common explicit offline phrase disables tool execution at the model boundary', async () => {
  const f = setup(async (_index, options) => { assert.equal(options.enabled, false); return { text: '仅使用已有信息。', calls: [] }; });
  const c = await f.create(); const turn = await f.send(c.id, '不要进行联网搜索，介绍 TypeScript');
  const final = await f.step(c.id, turn);
  assert.equal(final.state, 'complete'); assert.equal(f.searches.length, 0);
});
