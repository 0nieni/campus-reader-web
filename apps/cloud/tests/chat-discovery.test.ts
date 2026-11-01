import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiChatTurn, AiConversation } from '@campus/contracts';
import { fixtureDb, identity } from './feature-fixture';
import { aiService } from '../src/ai-service';
import { assistantService } from '../src/assistant-service';
import { AppError } from '../src/errors';

function setup(search?: Parameters<typeof assistantService>[4], reader?: Parameters<typeof assistantService>[5]) {
  const f = fixtureDb(), prompts: string[] = [], queries: string[] = [];
  process.env.AI_CHAT_BASE_URL = 'https://api.deepseek.com'; process.env.AI_CHAT_MODEL = 'fixture-model'; process.env.AI_CHAT_API_KEY = 'fixture-key'; process.env.AI_EXECUTION_MODE = 'direct';
  const originalSchool = f.repo.school;
  f.repo.school = async id => ({ ...(await originalSchool(id))!, homepage: 'https://www.bjtu.edu.cn/' });
  const originalItem = f.repo.item;
  f.repo.item = async id => await originalItem(id) || f.rows('items').get(id) as any || null;
  const ai = aiService(f.db, f.repo, async (_connection, _guide, content) => { prompts.push(content); return '公告需要报名材料。[R1](https://www.bjtu.edu.cn/test)'; });
  const assistant = assistantService(f.db, f.repo, ai, Date.now, async (school, query) => {
    queries.push(query);
    return search ? search(school, query) : { state: 'complete', message: '本次联网搜索已完成', candidates: [{ title: '竞赛报名公告', url: 'https://www.bjtu.edu.cn/test', snippet: '不得当成正文' }] };
  }, reader);
  const call = (action: string, input: Record<string, unknown>) => assistant.handle(action, input, identity);
  const create = async () => await call('ai.chat.create', { schoolId: 'bjtu', requestId: 'discovery-conversation-01' }) as AiConversation;
  const send = async (id: string, question: string, requestId = 'discovery-request-0001') => await call('ai.chat.send', { conversationId: id, question, requestId }) as AiChatTurn;
  const finish = async (id: string, turn: AiChatTurn) => { while (turn.state === 'ready') turn = await call('ai.chat.step', { conversationId: id, turnId: turn.id, step: turn.step }) as AiChatTurn; return turn; };
  return { ...f, call, create, send, finish, queries, prompts, ai };
}

test('an explicit chat search uses school discovery once, passes its status and limits the external query to topics', async () => {
  const f = setup(), c = await f.create();
  const question = '再帮我找找本校编程比赛，我的邮箱 private@example.invalid，目标是个人秘密';
  const turn = await f.send(c.id, question);
  assert.equal(f.queries.length, 1);
  assert.ok(f.queries[0].includes('编程') && f.queries[0].includes('比赛'));
  assert.ok(!f.queries[0].includes('private@') && !f.queries[0].includes('个人秘密'));
  assert.equal((turn as any).search.state, 'complete');
  await f.finish(c.id, turn);
  assert.ok(f.prompts.at(-1)!.includes('本次联网搜索已完成'));
  await f.send(c.id, question);
  assert.equal(f.queries.length, 1, 'retries must not repeat discovery');
  assert.equal((await f.ai.handle('ai.status', {}, identity) as any).quota.used, 1);
});

test('natural campus discovery questions actually search once and keep private wording out of the external query', async () => {
  for (const question of ['帮我查一下最近学校的比赛，我的邮箱 private@example.invalid', '最近我们学校有什么比赛可以报名', '帮我看看学校有没有新的讲座']) {
    const f = setup(), c = await f.create();
    const first = await f.send(c.id, question);
    assert.equal(f.queries.length, 1, question);
    assert.match(f.queries[0], /比赛|讲座/);
    assert.ok(!f.queries[0].includes('private') && !f.queries[0].includes('我的'));
    assert.equal(first.search?.state, 'complete');
    await f.send(c.id, question);
    assert.equal(f.queries.length, 1, 'retry must not execute discovery twice');
  }
});

test('capability questions use server configuration instead of searching or generating a cited model answer', async () => {
  const previous = process.env.TAVILY_API_KEY;
  try {
    for (const configured of [false, true]) {
      if (configured) process.env.TAVILY_API_KEY = 'fixture-search-key'; else delete process.env.TAVILY_API_KEY;
      const f = setup(), c = await f.create();
      f.items.clear(); delete process.env.AI_CHAT_API_KEY;
      const turn = await f.send(c.id, '你能联网吗');
      assert.equal(turn.state, 'complete'); assert.equal(turn.taskId, null);
      assert.match(turn.result!, configured ? /已配置/ : /未配置|还没配置|尚未配置/);
      assert.ok(!turn.result!.includes('fixture-search-key'));
      assert.deepEqual(turn.references, []);
      assert.equal(f.queries.length, 0); assert.equal(f.prompts.length, 0);
      const status = await f.ai.handle('ai.status', {}, identity) as any;
      assert.equal(status.searchConfigured, configured);
      assert.equal(status.quota.used, 0); assert.equal(status.quota.held, 0);
      assert.equal(status.officialConfigured, false);
      await f.send(c.id, '你能联网吗');
      assert.equal(f.queries.length, 0);
    }
  } finally { if (previous === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = previous; }
});

test('a structured upstream search failure reaches the chat turn without leaking credentials or claiming success', async () => {
  const f = setup(async () => ({ state: 'failed', code: 'authorization', message: '搜索服务授权异常，请联系网站管理员。', candidates: [] })), c = await f.create();
  const turn = await f.send(c.id, '帮我联网搜索本校比赛');
  assert.equal(turn.search?.code, 'authorization');
  assert.equal(turn.search?.state, 'failed');
  assert.match(turn.search!.message, /授权异常/);
  assert.ok(turn.references.some(reference => reference.itemId === 'notice'), 'existing readable material remains available');
});

test('ordinary followups, negated search and quoted instructions do not trigger discovery', async () => {
  for (const question of ['什么时候截止？', '不要联网搜索，只读现有公告', '不用再找找，只说材料', '找找本校比赛，但不要联网，只看已有公告', '“帮我搜索比赛”这句话是什么意思？']) {
    const f = setup(), c = await f.create();
    await f.send(c.id, question);
    assert.equal(f.queries.length, 0, question);
  }
});

test('unconfigured or failed chat discovery preserves local links without a model fallback and exposes the real search state', async () => {
  for (const state of ['failed', 'unconfigured'] as const) {
    const f = setup(async () => ({ state, message: state === 'failed' ? '本次联网搜索未完成' : '联网搜索未配置', candidates: [] })), c = await f.create();
    const turn = await f.send(c.id, '再找找本校比赛');
    assert.equal((turn as any).search.state, state);
    assert.equal(turn.taskId, null);
    assert.equal(turn.programReply, 'search_status');
    assert.ok(turn.references.some(ref => ref.itemId === 'notice'));
    assert.equal(f.prompts.length, 0);
    assert.match(turn.result!, /没有完成联网搜索/);
  }
});

test('five unreadable discovery candidates cannot hide readable local evidence from a chat reply', async () => {
  const f = setup(async () => ({ state: 'complete', message: '本次联网搜索已完成', candidates: Array.from({ length: 5 }, (_, index) => ({ title: `比赛报名通知${index}`, url: `https://www.bjtu.edu.cn/unreadable-${index}`, snippet: '仅摘要，不可作为正文' })) }), async () => { throw new Error('unreadable'); });
  const c = await f.create(), turn = await f.send(c.id, '再找找本校比赛');
  assert.equal(turn.search?.state, 'complete');
  assert.equal(turn.taskId, null, 'unreadable search results must not be disguised by a local model answer');
  assert.equal(turn.search?.candidateCount, 5);
  assert.equal(turn.search?.readableCount, 0);
  assert.equal(turn.programReply, 'search_status');
  assert.ok(turn.references.length > 0, 'verified original URLs remain available');
  assert.equal(f.prompts.length, 0);
  assert.match(turn.result!, /没有取得.*正文/);
});

test('a successful zero-result search is reported honestly without asking the model to answer from old notices', async () => {
  const f = setup(async () => ({ state: 'complete', message: '本次联网搜索已完成，未找到线索。', candidates: [] })), c = await f.create();
  const turn = await f.send(c.id, '帮我查一下本校蓝桥杯报名');
  assert.equal(turn.taskId, null);
  assert.equal(turn.programReply, 'search_status');
  assert.equal(turn.search?.state, 'complete');
  assert.equal(turn.search?.candidateCount, 0); assert.equal(turn.search?.readableCount, 0);
  assert.equal(f.prompts.length, 0);
  assert.match(turn.result!, /没找到|未找到/);
  assert.ok(turn.references.some(reference => reference.itemId === 'notice'));
  assert.equal((await f.ai.handle('ai.status', {}, identity) as any).quota.used, 0);
});

test('a candidate losing its body during authorized acquisition cannot be replaced by an unrelated local model answer', async () => {
  const f = setup(async () => ({ state: 'complete', message: '搜索完成', candidates: [{ title: '竞赛报名公告', url: 'https://www.bjtu.edu.cn/vanishing-body', snippet: '不是正文' }] }), async url => ({ url, html: '<article>竞赛报名公告。报名需要提交项目简介和报名表，具体资格以本校原公告为准。此段合成正文仅用于验证真实读取失败后的处理路径。</article>' }));
  f.repo.material = async row => row._id.startsWith('ai_search_item_') ? { ...row, contentText: '' } : row;
  const c = await f.create(), turn = await f.send(c.id, '帮我查一下本校比赛');
  assert.equal(turn.taskId, null);
  assert.equal(turn.programReply, 'search_status');
  assert.equal(turn.search?.candidateCount, 1); assert.equal(turn.search?.readableCount, 0);
  assert.equal(f.prompts.length, 0);
  assert.match(turn.result!, /没有取得.*正文/);
});

const bodyReader: NonNullable<Parameters<typeof assistantService>[5]> = async url => ({ url, html: '<article>竞赛报名公告。报名需要提交项目简介和报名表，具体资格以原公告为准。本段合成正文用于验证最后合包阶段失效和八篇明确选材的真实处理行为。</article>' });
const freshSearch: NonNullable<Parameters<typeof assistantService>[4]> = async () => ({ state: 'complete', message: '搜索完成', candidates: [{ title: '新比赛公告', url: 'https://www.bjtu.edu.cn/final-pack', snippet: '不是正文' }] });

test('seven explicit materials leave the final slot for a genuinely readable later search candidate', async () => {
  const f = setup(async () => ({ state: 'complete', message: '搜索完成', candidates: [
    { title: '首条比赛', url: 'https://www.bjtu.edu.cn/first-unreadable', snippet: '' },
    { title: '第二条比赛', url: 'https://www.bjtu.edu.cn/second-readable', snippet: '' },
  ] }), bodyReader), c = await f.create();
  const template = f.items.get('notice')!;
  const itemIds = Array.from({ length: 7 }, (_, index) => 'selected_' + index);
  for (const id of itemIds) f.items.set(id, { ...template, _id: id, title: id });
  f.repo.material = async row => row.originalUrl?.endsWith('/first-unreadable') ? { ...row, contentText: '' } : row;
  const turn = await f.call('ai.chat.send', { conversationId: c.id, question: '再找找本校比赛', requestId: 'seven-selection-search-01', itemIds }) as AiChatTurn;
  assert.equal(turn.state, 'ready'); assert.equal(turn.search?.readableCount, 1);
  const docs = f.rows('web_ai_tasks').get(turn.taskId!)!.docs;
  assert.equal(docs.length, 8);
  assert.ok(itemIds.every(id => docs.some((doc: any) => doc.itemId === id)), 'all seven explicit materials are preserved');
  assert.ok(docs.some((doc: any) => doc.originalUrl === 'https://www.bjtu.edu.cn/second-readable'));
  assert.ok(!docs.some((doc: any) => doc.originalUrl === 'https://www.bjtu.edu.cn/first-unreadable'));
});

test('eight explicit selections keep truthful search body counts and ask for room without reserving model quota', async () => {
  const f = setup(undefined, bodyReader), c = await f.create();
  const template = f.items.get('notice')!;
  const itemIds = Array.from({ length: 8 }, (_, index) => 'selected_' + index);
  for (const id of itemIds) f.items.set(id, { ...template, _id: id, title: id });
  const input = { conversationId: c.id, question: '最近我们学校有什么比赛可以报名', requestId: 'eight-selected-search-01', itemIds };
  const turn = await f.call('ai.chat.send', input) as AiChatTurn;
  assert.equal(turn.taskId, null); assert.equal(turn.programReply, 'search_status');
  assert.equal(turn.search?.candidateCount, 1); assert.equal(turn.search?.readableCount, 1);
  assert.match(turn.result!, /8|八/); assert.match(turn.result!, /减少|取消.*选择/);
  assert.doesNotMatch(turn.result!, /没有取得.*正文/);
  assert.equal(f.prompts.length, 0); assert.equal(f.rows('web_ai_tasks').size, 0);
  const quota = (await f.ai.handle('ai.status', {}, identity) as any).quota;
  assert.equal(quota.used, 0); assert.equal(quota.held, 0);
  assert.deepEqual(await f.call('ai.chat.send', input), turn);
  assert.equal(f.queries.length, 1);
});

test('a candidate failing only on final pack acquisition yields recoverable search status with rechecked body counts', async () => {
  for (const code of ['NO_MATERIAL', 'SOURCE_UNAVAILABLE']) {
    const f = setup(freshSearch, bodyReader), c = await f.create();
    let reads = 0;
    f.repo.material = async row => {
      if (row._id.startsWith('ai_search_item_') && ++reads >= 2) throw new AppError(code, 'synthetic body unavailable');
      return row;
    };
    const turn = await f.send(c.id, '再找找本校比赛');
    assert.equal(turn.state, 'complete'); assert.equal(turn.taskId, null);
    assert.equal(turn.programReply, 'search_status');
    assert.equal(turn.search?.state, 'complete'); assert.equal(turn.search?.candidateCount, 1); assert.equal(turn.search?.readableCount, 0);
    assert.ok(turn.references.length); assert.match(turn.result!, /没有取得.*正文/);
    assert.equal(f.prompts.length, 0); assert.equal(f.rows('web_ai_tasks').size, 0);
    const quota = (await f.ai.handle('ai.status', {}, identity) as any).quota;
    assert.equal(quota.used, 0); assert.equal(quota.held, 0);
  }
});

test('a transient final-pack failure still stops model work and reports successfully rechecked candidate bodies', async () => {
  const f = setup(freshSearch, bodyReader), c = await f.create();
  let reads = 0;
  f.repo.material = async row => {
    if (row._id.startsWith('ai_search_item_') && ++reads === 2) throw new AppError('SOURCE_UNAVAILABLE', 'transient');
    return row;
  };
  const turn = await f.send(c.id, '再找找本校比赛');
  assert.equal(turn.programReply, 'search_status'); assert.equal(turn.taskId, null);
  assert.equal(turn.search?.readableCount, 1);
  assert.match(turn.result!, /合并|准备/); assert.doesNotMatch(turn.result!, /没有取得.*正文/);
  assert.equal(f.prompts.length, 0); assert.equal(f.rows('web_ai_tasks').size, 0);
});

test('final-pack authorization and source policy revocation remain hard blocks without publishing search results', async () => {
  for (const code of ['STALE_SCOPE', 'UNAUTHENTICATED', 'AI_POLICY_BLOCKED']) {
    const f = setup(freshSearch, bodyReader), c = await f.create();
    let reads = 0;
    f.repo.material = async row => {
      if (row._id.startsWith('ai_search_item_') && ++reads === 2) throw new AppError(code, 'blocked');
      return row;
    };
    await assert.rejects(f.send(c.id, '再找找本校比赛'), { code });
    const turn = f.rows('web_ai_conversations').get(c.id)!.turns[0];
    assert.equal(turn.reply, undefined); assert.deepEqual(turn.references, []);
    assert.equal(f.prompts.length, 0); assert.equal(f.rows('web_ai_tasks').size, 0);
  }
});

test('saved program links are removed on reload after their source is disabled', async () => {
  const f = setup(async () => ({ state: 'failed', message: '搜索未完成', candidates: [] })), c = await f.create();
  const turn = await f.send(c.id, '帮我联网搜索本校比赛');
  assert.equal(turn.programReply, 'search_status');
  assert.ok(turn.references.some(reference => reference.itemId === 'notice'));
  f.rows('sources').get('source')!.enabled = false;
  const restored = await f.call('ai.chat.get', { conversationId: c.id }) as AiConversation;
  assert.deepEqual(restored.turns[0].references, []);
  assert.ok(!restored.turns[0].result?.includes('测试竞赛'));
  assert.equal(f.prompts.length, 0);
});

test('chat discovery may use verified new body text without requiring a second manual selection', async () => {
  const f = setup(async () => ({ state: 'complete', message: '搜索已完成', candidates: [{ title: '新编程竞赛报名通知', url: 'https://www.bjtu.edu.cn/new-contest', snippet: '不能当成正文的摘要' }] }), async url => ({ url, html: '<article>新编程竞赛报名通知。面向本校本科生，报名必须提交项目说明和报名表，资格和材料以本段合成正文为准。未提供具体截止日期，不应根据摘要推断。</article>' }));
  const c = await f.create(), turn = await f.send(c.id, '帮我搜索本校编程比赛');
  assert.equal(turn.state, 'ready');
  assert.equal(turn.references[0].originalUrl, 'https://www.bjtu.edu.cn/new-contest');
  const task = f.rows('web_ai_tasks').get(turn.taskId!)!;
  assert.ok(task.docs[0].markdown.includes('报名必须提交项目说明'));
  assert.ok(!task.docs[0].markdown.includes('不能当成正文的摘要'));
  assert.equal(f.rows('items').get(turn.references[0].itemId)!.ownerOpenid, identity.dataOwnerId);
});

test('same-request concurrent sends do not search twice and a different request waits for the preparation lock', { timeout: 3000 }, async () => {
  let reached!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; }), release = new Promise<void>(resolve => { resume = resolve; });
  const f = setup(async () => { reached(); await release; return { state: 'complete', message: '搜索完成', candidates: [] }; }), c = await f.create();
  const first = f.send(c.id, '再找找本校比赛');
  await started;
  try {
    const duplicate = await f.send(c.id, '再找找本校比赛');
    assert.equal(duplicate.state, 'running');
    await assert.rejects(f.send(c.id, '搜索本校讲座', 'another-discovery-0001'), (error: any) => error.code === 'TASK_BUSY');
    assert.equal(f.queries.length, 1);
  } finally { resume(); }
  const completed = await first;
  assert.equal(completed.state, 'complete');
  assert.equal(completed.programReply, 'search_status');
  assert.equal(f.prompts.length, 0);
});

test('cancelling search preparation prevents a late result from creating a model task', { timeout: 3000 }, async () => {
  let reached!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; }), release = new Promise<void>(resolve => { resume = resolve; });
  const f = setup(async () => { reached(); await release; return { state: 'complete', message: '搜索完成', candidates: [] }; }), c = await f.create();
  const first = f.send(c.id, '再找找本校比赛');
  await started;
  try {
    const turn = await f.call('ai.chat.cancel', { conversationId: c.id, turnId: 'discovery-request-0001' }) as AiChatTurn;
    assert.equal(turn.state, 'cancelled');
  } finally { resume(); }
  assert.equal((await first).state, 'cancelled');
  assert.equal(f.rows('web_ai_tasks').size, 0);
});

test('a school change during discovery stops task creation without leaking the old response', { timeout: 3000 }, async () => {
  let reached!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; }), release = new Promise<void>(resolve => { resume = resolve; });
  const f = setup(async () => { reached(); await release; return { state: 'complete', message: '搜索完成', candidates: [] }; }), c = await f.create();
  const first = f.send(c.id, '再找找本校比赛');
  await started;
  await f.repo.selectSchool(identity.dataOwnerId, 'other');
  resume();
  await assert.rejects(first, (error: any) => error.code === 'STALE_SCOPE');
  assert.equal(f.rows('web_ai_tasks').size, 0);
});

test('a stale preparation is stopped on read and never automatically replayed', async () => {
  const f = setup(), c = await f.create();
  f.rows('web_ai_conversations').get(c.id)!.turns = [{ id: 'stale-preparation-0001', question: '再找找比赛', fingerprint: '', taskId: null, materialIds: [], references: [], history: '', preparing: true, preparationStartedAt: Date.now() - 91000, service: 'official' }];
  f.rows('web_ai_conversations').get(c.id)!.pendingTurn = 'stale-preparation-0001';
  const restored = await f.call('ai.chat.get', { conversationId: c.id }) as AiConversation;
  assert.equal(restored.turns[0].state, 'failed');
  assert.ok(restored.turns[0].message.includes('超时'));
  assert.equal(f.rows('web_ai_conversations').get(c.id)!.pendingTurn, null);
  assert.equal(f.queries.length, 0);
});

test('search throttling explains the failure and preserves local links without replaying the search provider', async () => {
  const f = setup(), c = await f.create();
  await f.finish(c.id, await f.send(c.id, '再找找本校比赛'));
  const next = await f.send(c.id, '再找找本校讲座', 'throttled-search-0001');
  assert.equal(next.search?.state, 'failed');
  assert.ok(next.search?.message.includes('15 秒'));
  assert.equal(next.taskId, null);
  assert.equal(next.programReply, 'search_status');
  assert.equal(f.queries.length, 1);
});
