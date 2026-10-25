import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureDb, identity } from './feature-fixture';
import { assistantProfile } from '../src/assistant-profile';
import { memoryService } from '../src/assistant-memory';

test('automatically remembered interests help ranking while explicit preferences and disabling memory take priority', async () => {
  const f = fixtureDb(), current = Date.now();
  const original = f.items.get('notice')!;
  f.items.clear();
  f.items.set('programming', { ...original, _id: 'programming', title: '编程比赛报名', contentText: '编程比赛材料', publishedAt: new Date(current - 1000).toISOString(), categories: ['competition'] });
  f.items.set('lecture', { ...original, _id: 'lecture', title: '学术讲座通知', contentText: '讲座地点', publishedAt: new Date(current).toISOString(), categories: ['academic'] });
  const memory = memoryService(f.db, f.repo), profile = assistantProfile(f.db, f.repo);
  assert.equal(await memory.apply(identity.dataOwnerId, 'bjtu', { requestId: 'memory-ranking-00001', question: '我对编程竞赛很感兴趣', proposals: [{ slot: 'interests', text: '我对编程竞赛很感兴趣', evidence: '我对编程竞赛很感兴趣' }], generation: 0, observedAt: new Date(current - 1).toISOString() }), 1);
  let result = await profile.recommend(identity.dataOwnerId, 'bjtu');
  assert.equal(result.items[0].id, 'programming');
  assert.match(result.items[0].reason, /自动记忆/);
  await profile.handle('ai.profile.save', { schoolId: 'bjtu', interests: ['讲座'], goals: '', learningEnabled: false, version: 0 }, identity);
  result = await profile.recommend(identity.dataOwnerId, 'bjtu');
  assert.equal(result.items[0].id, 'lecture');
  const state = await memory.get(identity.dataOwnerId, 'bjtu');
  await memory.handle('ai.memory.configure', { schoolId: 'bjtu', enabled: false, version: state.version }, identity);
  result = await profile.recommend(identity.dataOwnerId, 'bjtu');
  assert.ok(result.items.every(item => !item.reason.includes('自动记忆')));
});
