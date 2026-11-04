import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureDb, identity } from './feature-fixture';
import { aiService } from '../src/ai-service';
import { assistantService } from '../src/assistant-service';
import * as helpers from '../src/chat-intent';
import { publicToolQuery } from '../src/chat-web-tools';

test('current Beijing calendar dates stay intact in public queries, including the production rejected year', () => {
  const now = Date.parse('2026-11-03T23:30:00Z');
  for (const date of ['2026年', '2026年11月', '2026年11月4日', '2026-11-04']) {
    const query = `北京交通大学 ${date} 竞赛 通知`;
    assert.equal(publicToolQuery('最近有什么比赛吗', query, '北京交通大学', now), query);
  }
  assert.equal(publicToolQuery('最近有什么比赛吗', '北京交通大学 2027年 竞赛', '北京交通大学', now), null);
  assert.equal(publicToolQuery('最近有什么比赛吗', '北京交通大学 2026年11月5日 竞赛', '北京交通大学', now), null);
  assert.equal(publicToolQuery('最近有什么比赛吗', '北京交通大学 2026年 私人单位 竞赛', '北京交通大学', now), null);
  const newYear = Date.parse('2026-12-31T16:30:00Z');
  assert.equal(publicToolQuery('最近有什么比赛吗', '北京交通大学 2027年 竞赛', '北京交通大学', newYear), '北京交通大学 2027年 竞赛');
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

test('automatic queries cannot carry memory facts, personal clauses, credentials or a no-network instruction', () => {
  const p = helpers as any;
  assert.equal(typeof p.publicToolQuery, 'function');
  assert.equal(p.publicToolQuery('介绍 TypeScript 教程，我的邮箱 private@example.invalid', 'TypeScript 教程', '北京交通大学'), 'TypeScript 教程');
  assert.equal(p.publicToolQuery('介绍 TypeScript 教程，我的邮箱 private@example.invalid', 'private@example.invalid', '北京交通大学'), null);
  assert.equal(p.publicToolQuery('介绍 TypeScript 教程', '我在秘密公司实习 TypeScript', '北京交通大学'), null);
  assert.equal(p.publicToolQuery('今天学校有什么比赛', '北京交通大学 比赛', '北京交通大学'), '北京交通大学 比赛');
  assert.equal(p.publicToolQuery('不要联网，介绍 TypeScript', 'TypeScript', '北京交通大学'), null);
  assert.equal(p.publicToolQuery('介绍 TypeScript', 'https://127.0.0.1/admin', '北京交通大学'), null);
  assert.equal(p.publicToolQuery('介绍 TypeScript 教程', '秘 密', '北京交通大学'), null);
  assert.equal(p.publicToolQuery('Do not browse the web. Explain TypeScript', 'TypeScript', '北京交通大学'), null);
  assert.equal(p.publicToolQuery('介绍 TypeScript 教程', 'TypeScript конфиденциально', '北京交通大学'), null);
  assert.equal(p.publicToolQuery('介绍 TypeScript 教程', 'TypeScript プライベート', '北京交通大学'), null);
  assert.equal(p.publicToolQuery('不要进行联网搜索，介绍 TypeScript', 'TypeScript', '北京交通大学'), null);
});
