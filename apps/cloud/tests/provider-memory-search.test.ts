import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiChatTurn, AiConversation, AiMemoryState } from '@campus/contracts';
import { fixtureDb, identity } from './feature-fixture';
import { aiService } from '../src/ai-service';
import { assistantService } from '../src/assistant-service';
import type { ProviderProfiles } from '../src/ai-provider-profiles';

test('saved models preserve memory and combine site and external evidence without official quota', async () => {
  const f = fixtureDb(), prompts: string[] = [], queries: string[] = [], fact = '我想长期积累项目经验';
  const original = f.repo.item;
  f.repo.item = async id => await original(id) || f.rows('items').get(id) as any || null;
  const ref = { id: 'personal-config', version: 3 };
  const providers: ProviderProfiles = {
    async state() { throw new Error('unused'); }, async handle() { throw new Error('unused'); },
    async resolve(owner, value, model) { assert.equal(owner, identity.dataOwnerId); assert.deepEqual(value, ref); return { provider: 'custom', protocol: 'openai-chat', endpoint: 'https://provider.example.org/v1/chat/completions', model, apiKey: 'synthetic-test-only' }; },
    async guard(_tx, owner, value) { assert.equal(owner, identity.dataOwnerId); assert.deepEqual(value, ref); },
  };
  const prior = process.env.AI_EXECUTION_MODE; process.env.AI_EXECUTION_MODE = 'direct';
  try {
    const ai = aiService(f.db, f.repo, async (connection, _guide, content) => {
      assert.equal(connection.model, 'personal-model'); prompts.push(content);
      const citation = content.includes('https://docs.example.org/guide') ? '[R2](https://docs.example.org/guide)' : '[R1](https://www.bjtu.edu.cn/test)';
      return `已读取本轮资料。${citation}\n<!--campus-memory ${JSON.stringify({ items: content.includes(fact) ? [{ slot: 'goal', text: fact, evidence: fact }] : [] })} -->`;
    }, Date.now, undefined, providers);
    const assistant = assistantService(f.db, f.repo, ai, Date.now, async (_school, query) => {
      queries.push(query); return { state: 'complete', message: '全网搜索完成', candidates: [{ title: 'TypeScript Promise 教程', url: 'https://docs.example.org/guide', snippet: '非正文' }] };
    }, async url => ({ url, html: '<article>外部公开教程正文。Promise 是异步操作的结果表示，本段为合成测试正文，和本校资料分别引用。</article>' }), providers);
    const call = (action: string, input: Record<string, unknown>) => assistant.handle(action, input, identity);
    const create = async (requestId: string) => await call('ai.chat.create', { schoolId: 'bjtu', requestId }) as AiConversation;
    const send = async (c: AiConversation, requestId: string, question: string) => await call('ai.chat.send', { conversationId: c.id, requestId, question, itemIds: ['notice'], service: 'byok', providerProfile: ref, model: 'personal-model' }) as AiChatTurn;
    const finish = async (c: AiConversation, turn: AiChatTurn) => {
      while (turn.state === 'ready') turn = await call('ai.chat.step', { conversationId: c.id, turnId: turn.id, step: turn.step }) as AiChatTurn;
      assert.equal(turn.state, 'complete', turn.message); assert.deepEqual(turn.providerProfile, ref);
    };
    const first = await create('provider-memory-conversation-1');
    await finish(first, await send(first, 'provider-memory-request-1', fact + '，这个比赛需要什么材料？'));
    assert.ok((await call('ai.memory.get', { schoolId: 'bjtu' }) as AiMemoryState).items.some(item => item.text === fact));
    const second = await create('provider-memory-conversation-2'), next = await send(second, 'provider-memory-request-2', '联网搜索 TypeScript Promise 教程');
    assert.equal(next.references.length, 2);
    assert.ok(next.references.some(item => item.originalUrl === 'https://www.bjtu.edu.cn/test'));
    assert.ok(next.references.some(item => item.originalUrl === 'https://docs.example.org/guide'));
    await finish(second, next);
    assert.deepEqual(queries, ['TypeScript Promise 教程']); assert.ok(prompts.at(-1)!.includes(fact));
    assert.equal((await ai.handle('ai.status', {}, identity) as any).quota.used, 0);
  } finally { if (prior === undefined) delete process.env.AI_EXECUTION_MODE; else process.env.AI_EXECUTION_MODE = prior; }
});
