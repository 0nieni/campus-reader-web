import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureDb, identity } from './feature-fixture';
import { aiService } from '../src/ai-service';
import { assistantService } from '../src/assistant-service';
import { automaticSearchQuery } from '../src/chat-web-tools';

test('direct search keeps ordinary joined words, dates and Unicode subjects without a topic whitelist', () => {
  for (const question of ['最近有什么比赛吗', '2026年11月 学科竞赛 报名通知', 'TypeScript プライベート 教程', '你好']) {
    assert.equal(automaticSearchQuery(question, '北京交通大学'), `北京交通大学 ${question}`);
  }
  assert.equal(Array.from(automaticSearchQuery('长问题'.repeat(200), '北京交通大学')!).length, 128);
  assert.equal(automaticSearchQuery('TypeScript\n教程', '北京交通大学'), '北京交通大学 TypeScript 教程');
  assert.equal(automaticSearchQuery('  ', '北京交通大学'), null);
});

test('explicit offline requests are the exception to default search', () => {
  for (const question of ['不要联网，介绍 TypeScript', '不要进行联网搜索，介绍 TypeScript', '只看已有公告', 'Do not browse the web. Explain TypeScript']) {
    assert.equal(automaticSearchQuery(question, '北京交通大学'), null);
  }
});

test('agent search discovers leads without reading; only a chosen candidate is fetched through existing policy', async () => {
  const f = fixtureDb(), reads: string[] = [];
  const old = f.repo.item;
  f.repo.item = async id => await old(id) || f.rows('items').get(id) as any || null;
  const assistant = assistantService(f.db, f.repo, aiService(f.db, f.repo), Date.now, async () => ({ state: 'complete', message: '已搜索', candidates: [{ title: '公开教程', url: 'https://example.org/tutorial', snippet: 'untrusted snippet' }] }), async url => {
    reads.push(url); return { url, html: '<main><article>这是公开教程真实正文，有足够的长度能够通过现有正文提取以及资料权限复核。</article></main>' };
  });
  assert.ok((assistant as any).webTools, 'assistant must expose its safe search/read runtime to chat tasks');
  const tools = (assistant as any).webTools;
  const found = await tools.search('bjtu', '公开教程', identity);
  assert.equal(found.items[0].readState, 'snippet_only');
  assert.equal(reads.length, 0);
  const read = await tools.read('bjtu', found.items[0], identity);
  assert.deepEqual(reads, ['https://example.org/tutorial']);
  assert.equal(read.search.readableCount, 1);
  assert.equal(f.rows('user_profiles').get(identity.dataOwnerId)!.aiSearchBudget.count, 1);
  f.rows('sources').get(read.items[0].sourceId || [...f.rows('sources').keys()].find(key => key.startsWith('ai_search_')))!.aiProcessing = 'import_only';
  const denied = await tools.read('bjtu', found.items[0], identity);
  assert.equal(denied.items[0].allowAi, false);
  assert.equal(reads.length, 1, 'known restricted URL must not be fetched again');
});
