import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiMemoryState } from '@campus/contracts';
import { memoryService, type MemoryProposal } from '../src/assistant-memory';
import { fixtureDb, identity } from './feature-fixture';

const at = Date.parse('2026-10-22T03:00:00Z'), day = 86400000;
const major: MemoryProposal = { slot: 'major', text: '我是计算机专业', evidence: '我是计算机专业' };
function setup() {
  const f = fixtureDb(); let clock = at;
  const service = memoryService(f.db, f.repo, () => clock);
  const state = () => service.get(identity.dataOwnerId, 'bjtu');
  const apply = (requestId = 'r1', proposals: MemoryProposal[] = [major], extra: Record<string, unknown> = {}) => service.apply(identity.dataOwnerId, 'bjtu', { requestId, question: proposals.map(p => p.evidence).join('。'), proposals, generation: 0, observedAt: at, ...extra });
  const handle = (action: string, input: Record<string, unknown> = {}) => service.handle(action, { schoolId: 'bjtu', ...input }, identity) as Promise<AiMemoryState>;
  return { ...f, service, state, apply, handle, advance: (ms: number) => { clock += ms; } };
}

test('memory defaults enabled without creating a profile; writes preserve other preferences, schools and owners', async () => {
  const f = setup(), who = { ...identity, dataOwnerId: 'another-owner' };
  assert.deepEqual(await f.service.get(who.dataOwnerId, 'bjtu'), { schoolId: 'bjtu', enabled: true, version: 0, generation: 0, items: [] });
  assert.equal(f.rows('user_profiles').has(who.dataOwnerId), false);
  const row = f.rows('user_profiles').get(identity.dataOwnerId)!;
  row.aiAssistant = { bjtu: { preferences: { interests: ['机器人'], learningEnabled: false, version: 8 } } };
  row.aiMemory = { other: { enabled: false, version: 5, generation: 2, items: [] } };
  row.webBookmarks = ['keep'];
  assert.equal(await f.apply(), 1);
  const stored = f.rows('user_profiles').get(identity.dataOwnerId)!;
  assert.deepEqual(stored.aiAssistant, row.aiAssistant);
  assert.deepEqual(stored.aiMemory.other, row.aiMemory.other);
  assert.deepEqual(stored.webBookmarks, ['keep']);
  assert.equal(stored.unrelated, 'preserve');
  assert.equal((await f.state()).items[0].text, major.text);
  assert.equal((await f.service.get(who.dataOwnerId, 'bjtu')).items.length, 0);
  // A real selectedSchool implementation requires a saved owner profile before writes.
  f.rows('user_profiles').set(who.dataOwnerId, { _id: who.dataOwnerId, selectedSchoolId: 'bjtu' });
  assert.equal(await f.service.apply(who.dataOwnerId, 'bjtu', { requestId: 'own', question: major.text, proposals: [major], generation: 0, observedAt: at }), 1);
  assert.equal(f.rows('user_profiles').has(who.dataOwnerId), true);
});

test('memory operations trust identity, enforce selected school and expose no browser write action', async () => {
  const f = setup();
  await f.handle('ai.memory.configure', { enabled: false, version: 0, owner: 'victim', dataOwnerId: 'victim' });
  assert.equal((await f.state()).enabled, false);
  assert.equal(f.rows('user_profiles').has('victim'), false);
  await assert.rejects(f.handle('ai.memory.get', { schoolId: 'other' }), { code: 'STALE_SCOPE' });
  await assert.rejects(f.service.get(identity.dataOwnerId, 'missing'), { code: 'SCHOOL_NOT_FOUND' });
  await assert.rejects(f.handle('ai.memory.apply'), { code: 'ACTION_NOT_ALLOWED' });
  await f.repo.selectSchool(identity.dataOwnerId, 'other');
  await assert.rejects(f.apply(), { code: 'STALE_SCOPE' });
  assert.equal((await f.service.get(identity.dataOwnerId, 'other')).enabled, true);
});

test('only verbatim, bounded, personal future-use facts can be stored and evidence is not retained separately', async () => {
  const invalid: Array<[string, unknown]> = [
    ['我是计算机专业', [{ ...major, text: '计算机学生' }]],
    ['我是计算机专业', [{ ...major, evidence: '我是数学专业', text: '我是数学专业' }]],
    ['我喜欢编程', [{ slot: 'unknown', text: '我喜欢编程', evidence: '我喜欢编程' }]],
    ['我是计算机专业', [{ ...major, text: 42 }]],
    ['我喜欢' + '编'.repeat(181), [{ slot: 'interests', text: '我喜欢' + '编'.repeat(181), evidence: '我喜欢' + '编'.repeat(181) }]],
    ['假如我是计算机专业，有什么比赛？', [major]],
    ['If I am a computer science major, what should I do?', [{ slot: 'major', text: 'I am a computer science major', evidence: 'I am a computer science major' }]],
    ['我的朋友说：\n我是计算机专业', [major]],
    ['我的朋友说：我是计算机专业', [major]],
    ['公告写着“我是计算机专业”', [major]],
    ['我不是计算机专业', [{ ...major, text: '我不是计算机专业', evidence: '我不是计算机专业' }]],
    ['我是计算机专业吗？', [{ ...major, text: '我是计算机专业吗', evidence: '我是计算机专业吗' }]],
    ['不要记住，我是计算机专业', [major]],
    ['我今天吃了面条', [{ slot: 'interests', text: '我今天吃了面条', evidence: '我今天吃了面条' }]],
    ['我想看看公告', [{ slot: 'goal', text: '我想看看公告', evidence: '我想看看公告' }]],
    ['我是计算机专业，我的密码是 secret123', [{ ...major, text: '我的密码是 secret123', evidence: '我的密码是 secret123' }]],
    ['我喜欢编程，邮箱是 test@example.com', [{ slot: 'interests', text: '我喜欢编程，邮箱是 test@example.com', evidence: '我喜欢编程，邮箱是 test@example.com' }]],
    ['我喜欢编程，电话13812345678', [{ slot: 'interests', text: '我喜欢编程，电话13812345678', evidence: '我喜欢编程，电话13812345678' }]],
    ['我喜欢编程，证件110105199001011234', [{ slot: 'interests', text: '我喜欢编程，证件110105199001011234', evidence: '我喜欢编程，证件110105199001011234' }]],
    [('我喜欢编程 sk-' + 'abcdefghijklmnopqrstuvwx'), [{ slot: 'interests', text: ('我喜欢编程 sk-' + 'abcdefghijklmnopqrstuvwx'), evidence: ('我喜欢编程 sk-' + 'abcdefghijklmnopqrstuvwx') }]],
    ['我喜欢编程\u0000', [{ slot: 'interests', text: '我喜欢编程\u0000', evidence: '我喜欢编程\u0000' }]],
    ['我喜欢编程', [{ slot: 'interests', text: '', evidence: '' }]],
  ];
  for (const [question, proposals] of invalid) {
    const f = setup();
    assert.equal(await f.apply('invalid', proposals as MemoryProposal[], { question }), 0, question);
    assert.equal((await f.state()).version, 0, question);
    assert.equal(f.rows('user_profiles').get(identity.dataOwnerId)!.aiMemory, undefined);
  }
  const f = setup(); await f.apply();
  const saved = f.rows('user_profiles').get(identity.dataOwnerId)!.aiMemory.bjtu.items[0];
  assert.equal(saved.evidence, undefined);
  assert.equal(saved.question, undefined);
});

test('six slots accept clear personal claims, at most two proposals per turn and one latest item per slot', async () => {
  const f = setup();
  const statements = [major, { slot: 'year', text: '我现在大二', evidence: '我现在大二' }, { slot: 'interests', text: '我长期喜欢机器人', evidence: '我长期喜欢机器人' }, { slot: 'response_style', text: '我希望回答先给结论', evidence: '我希望回答先给结论' }, { slot: 'goal', text: '我准备参加蓝桥杯', evidence: '我准备参加蓝桥杯' }, { slot: 'progress', text: '我已经完成报名', evidence: '我已经完成报名' }] as MemoryProposal[];
  assert.equal(await f.apply('too-many', statements), 0);
  for (let i = 0; i < statements.length; i += 2) assert.equal(await f.apply(`pair-${i}`, statements.slice(i, i + 2)), 2);
  assert.equal((await f.state()).items.length, 6);
  assert.equal((await f.state()).version, 3);
  assert.equal(await f.apply('duplicate-slot', [major, { slot: 'major', text: '我是数学专业', evidence: '我是数学专业' }]), 0);
  assert.equal((await f.state()).items.length, 6);
});

test('mixed question saves a long-term personal goal and repeated progress does not slide its original expiry', async () => {
  const f = setup();
  const goal = { slot: 'goal', text: '我想长期积累项目经验', evidence: '我想长期积累项目经验' } as MemoryProposal;
  assert.equal(await f.apply('goal', [goal], { question: '我想长期积累项目经验，这个比赛需要准备什么？' }), 1);
  const progress = { slot: 'progress', text: '我已完成报名', evidence: '我已完成报名' } as MemoryProposal;
  assert.equal(await f.apply('progress', [progress]), 1);
  f.advance(29 * day);
  assert.equal(await f.apply('repeat-progress', [progress], { observedAt: at + 29 * day }), 0);
  f.advance(day);
  assert.deepEqual((await f.state()).items.map(item => item.slot), ['goal']);
});

test('personal interests and response preferences accept natural first-person phrasing', async () => {
  const f = setup();
  const proposals = [{ slot: 'interests', text: '我对编程感兴趣', evidence: '我对编程感兴趣' }, { slot: 'response_style', text: '我更喜欢回答简短些', evidence: '我更喜欢回答简短些' }] as MemoryProposal[];
  assert.equal(await f.apply('natural', proposals), 2);
  assert.deepEqual((await f.state()).items.map(item => item.text), ['我对编程感兴趣', '我更喜欢回答简短些']);
});

test('bodyless slot watermarks still reject older callbacks after retained memory text is removed', async () => {
  const f = setup();
  f.advance(2 * day);
  assert.equal(await f.apply('latest', [major], { observedAt: at + 2 * day }), 1);
  const row = f.rows('user_profiles').get(identity.dataOwnerId)!.aiMemory.bjtu;
  assert.deepEqual(row.updatedAtBySlot, { major: new Date(at + 2 * day).toISOString() });
  row.items = []; // Retention removes text while retaining its timestamp metadata.
  assert.equal(await f.apply('old-bodyless', [major], { observedAt: at + day }), 0);
  assert.deepEqual((await f.state()).items, []);
  assert.equal((await f.state()).version, 1);
  f.advance(day);
  assert.equal(await f.apply('fresh-bodyless', [major], { observedAt: at + 3 * day }), 1);
});

test('request ids are idempotent, duplicate text does not renew expiration and older observations never overwrite corrections', async () => {
  const f = setup(); assert.equal(await f.apply(), 1);
  const corrected = { slot: 'major', text: '我已经转到数学专业', evidence: '我已经转到数学专业' } as MemoryProposal;
  f.advance(day);
  assert.equal(await f.apply('r1', [corrected], { observedAt: at + day }), 0);
  assert.equal(await f.apply('new', [corrected], { observedAt: new Date(at + day).toISOString() }), 1);
  assert.equal(await f.apply('late', [major]), 0);
  assert.equal(await f.apply('same-time', [major], { observedAt: at + day }), 0);
  const first = (await f.state()).items[0];
  f.advance(day);
  assert.equal(await f.apply('unchanged', [corrected], { observedAt: at + 2 * day }), 0);
  assert.deepEqual((await f.state()).items[0], first);
  assert.equal((await f.state()).version, 2);
  assert.equal(first.createdAt, new Date(at).toISOString());
  assert.equal(first.updatedAt, new Date(at + day).toISOString());
});

test('repeated current facts advance observation watermarks so a delayed intermediate correction cannot reverse them', async () => {
  const f = setup();
  assert.equal(await f.apply('t1'), 1);
  f.advance(2 * day);
  assert.equal(await f.apply('t3', [major], { observedAt: at + 2 * day }), 0);
  const math = { slot: 'major', text: '我是数学专业', evidence: '我是数学专业' } as MemoryProposal;
  assert.equal(await f.apply('delayed-t2', [math], { observedAt: at + day }), 0);
  const state = await f.state();
  assert.equal(state.items[0].text, major.text);
  assert.equal(state.items[0].updatedAt, new Date(at).toISOString());
  assert.equal(state.version, 1);
  assert.equal(f.rows('user_profiles').get(identity.dataOwnerId)!.aiMemory.bjtu.updatedAtBySlot.major, new Date(at + 2 * day).toISOString());
});

test('expires year at 365 days, goal at 180, progress at 30 and rejects already-expired or future observations', async () => {
  const f = setup();
  const values = [{ slot: 'year', text: '我现在大二', evidence: '我现在大二' }, { slot: 'goal', text: '我准备参加蓝桥杯', evidence: '我准备参加蓝桥杯' }, { slot: 'progress', text: '我已完成报名', evidence: '我已完成报名' }] as MemoryProposal[];
  for (let i = 0; i < values.length; i++) await f.apply(`expire-${i}`, [values[i]]);
  await f.apply('permanent', [major, { slot: 'interests', text: '我喜欢编程', evidence: '我喜欢编程' }]);
  f.advance(30 * day);
  assert.deepEqual((await f.state()).items.map(item => item.slot).sort(), ['goal', 'interests', 'major', 'year']);
  assert.equal(await f.apply('late-progress', [values[2]]), 0);
  f.advance(150 * day);
  assert.equal((await f.state()).items.some(item => item.slot === 'goal'), false);
  f.advance(185 * day);
  assert.deepEqual((await f.state()).items.map(item => item.slot).sort(), ['interests', 'major']);
  assert.equal(await f.apply('future', [major], { observedAt: at + 366 * day }), 0);
  assert.equal(await f.apply('bad-time', [major], { observedAt: 'not-a-date' }), 0);
});

test('forget, clear and configure advance generation and prevent old callbacks from restoring deleted data', async () => {
  const f = setup(); await f.apply();
  const forgotten = await f.handle('ai.memory.forget', { id: 'major', version: 1 });
  assert.deepEqual({ version: forgotten.version, generation: forgotten.generation, items: forgotten.items }, { version: 2, generation: 1, items: [] });
  assert.equal(await f.apply('late-after-delete'), 0);
  assert.equal(await f.apply('fresh-after-delete', [major], { generation: 1 }), 1);
  const disabled = await f.handle('ai.memory.configure', { enabled: false, version: 3 });
  assert.equal(disabled.items.length, 1);
  assert.equal(disabled.generation, 2);
  assert.equal(await f.apply('disabled', [major], { generation: 2 }), 0);
  const enabled = await f.handle('ai.memory.configure', { enabled: true, version: 4 });
  assert.equal(enabled.generation, 3);
  assert.equal(await f.apply('old-enabled', [major], { generation: 2 }), 0);
  const cleared = await f.handle('ai.memory.clear', { version: 5 });
  assert.equal(cleared.version, 6); assert.equal(cleared.generation, 4); assert.deepEqual(cleared.items, []);
  assert.equal(await f.apply('late-after-clear', [major], { generation: 3 }), 0);
});

test('configuration validation and versions reject concurrent changes without clobbering a winner', async () => {
  const f = setup();
  for (const input of [{ version: -1, enabled: true }, { version: 0, enabled: 'yes' }, { enabled: false }, { version: 0.5, enabled: false }]) await assert.rejects(f.handle('ai.memory.configure', input), { code: 'VALIDATION_FAILED' });
  await assert.rejects(f.handle('ai.memory.forget', { version: 0, id: '__proto__' }), { code: 'VALIDATION_FAILED' });
  const results = await Promise.allSettled([f.handle('ai.memory.configure', { version: 0, enabled: false }), f.handle('ai.memory.clear', { version: 0 })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'MEMORY_CONFLICT');
  assert.equal((await f.state()).version, 1);
});

test('memory transactions never obtain another repository connection while holding their transaction client', async () => {
  const f = setup();
  let locked = false;
  const start = f.db.startTransaction.bind(f.db), school = f.repo.school.bind(f.repo), selectedSchool = f.repo.selectedSchool.bind(f.repo);
  f.db.startTransaction = async () => {
    const tx = await start(); locked = true;
    const commit = tx.commit.bind(tx), rollback = tx.rollback.bind(tx);
    tx.commit = async () => { try { return await commit(); } finally { locked = false; } };
    tx.rollback = async () => { try { return await rollback(); } finally { locked = false; } };
    return tx;
  };
  f.repo.school = async id => { assert.equal(locked, false, 'repository school query would wait for its own transaction connection'); return school(id); };
  f.repo.selectedSchool = async owner => { assert.equal(locked, false, 'repository profile query would wait for its own transaction connection'); return selectedSchool(owner); };
  assert.equal(await f.apply(), 1);
  assert.equal((await f.handle('ai.memory.configure', { enabled: false, version: 1 })).enabled, false);
});

test('locked profile scope rejects a school switch between authorization and mutation', async () => {
  for (const operation of ['apply', 'configure', 'command']) {
    const f = setup(), start = f.db.startTransaction.bind(f.db);
    f.db.startTransaction = async () => {
      f.rows('user_profiles').get(identity.dataOwnerId)!.selectedSchoolId = 'other';
      return start();
    };
    if (operation === 'apply') await assert.rejects(f.apply(), { code: 'STALE_SCOPE' });
    else if (operation === 'configure') await assert.rejects(f.handle('ai.memory.configure', { enabled: false, version: 0 }), { code: 'STALE_SCOPE' });
    else await assert.rejects(f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'scope-command', question: '清空自动记忆' }), { code: 'STALE_SCOPE' });
    assert.equal(f.rows('user_profiles').get(identity.dataOwnerId)!.aiMemory, undefined);
  }
});

test('recent request ledger remains bounded and never retains raw question or evidence', async () => {
  const f = setup(); await f.apply();
  for (let i = 0; i < 45; i++) await f.apply(`repeat-${i}`);
  const stored = f.rows('user_profiles').get(identity.dataOwnerId)!.aiMemory.bjtu;
  assert.equal(stored.processedRequests.length, 40);
  assert.equal(stored.processedRequests.includes('r1'), false);
  assert.equal(stored.processedRequests.includes('repeat-44'), true);
  assert.equal((await f.state()).version, 1);
  assert.equal(stored.question, undefined);
});

const goalProposal = (text: string, goalId?: string): MemoryProposal => ({ slot: 'goal', text, evidence: text, ...(goalId ? { goalId } : {}) });

test('three independent stable goals coexist, a fourth cannot evict one, and targeted corrections retain identity', async () => {
  const f = setup();
  for (const [i, text] of ['我准备考研', '我准备申请实习', '我计划参加蓝桥杯'].entries()) {
    assert.equal(await f.apply(`independent-${i}`, [goalProposal(text)]), 1);
  }
  const initial = (await f.state()).items;
  assert.equal(initial.length, 3);
  assert.equal(new Set(initial.map(item => item.id)).size, 3);
  assert.equal(await f.apply('fourth', [goalProposal('我计划学习英语')]), 0);
  f.advance(day);
  assert.equal(await f.apply('correct-goal', [goalProposal('我准备申请暑期实习', initial[1].id)], { observedAt: at + day }), 1);
  const updated = (await f.state()).items;
  assert.equal(updated.length, 3);
  assert.equal(updated.find(item => item.id === initial[1].id)?.text, '我准备申请暑期实习');
  assert.equal(updated.find(item => item.id === initial[0].id)?.text, '我准备考研');
  assert.equal(await f.apply('missing-target', [goalProposal('我准备学习英语', 'missing')], { observedAt: at + day }), 0);
});

test('progress requires an explicit goal with multiple goals and forget cascades only its own progress', async () => {
  const f = setup();
  await f.apply('g1', [goalProposal('我准备考研')]); await f.apply('g2', [goalProposal('我准备申请实习')]);
  const [g1, g2] = (await f.state()).items;
  const progress = { slot: 'progress', text: '我已完成报名材料', evidence: '我已完成报名材料' } as MemoryProposal;
  assert.equal(await f.apply('ambiguous-progress', [progress]), 0);
  assert.equal(await f.apply('linked-progress', [{ ...progress, goalId: g1.id }]), 1);
  assert.equal((await f.state()).items.find(item => item.slot === 'progress')?.goalId, g1.id);
  const state = await f.state();
  const result = await f.handle('ai.memory.forget', { id: g1.id, version: state.version });
  assert.deepEqual(result.items.map(item => item.id), [g2.id]);
  assert.equal(await f.apply('late', [{ ...progress, goalId: g1.id }]), 0);
});

test('legacy goal/progress remain readable, linked progress never outlives its goal', async () => {
  const f = setup(), stamp = new Date(at).toISOString();
  f.rows('user_profiles').get(identity.dataOwnerId)!.aiMemory = { bjtu: { version: 1, generation: 0, items: [
    { id: 'goal', slot: 'goal', text: '我准备考研', createdAt: stamp, updatedAt: stamp, expiresAt: new Date(at + 2 * day).toISOString() },
    { id: 'progress', slot: 'progress', text: '我已完成报名', createdAt: stamp, updatedAt: stamp, expiresAt: new Date(at + 30 * day).toISOString() },
  ] } };
  assert.deepEqual((await f.state()).items.map(item => item.id), ['goal', 'progress']);
  f.advance(day);
  const text = '我已提交报名材料';
  assert.equal(await f.apply('new-progress', [{ slot: 'progress', text, evidence: text, goalId: 'goal' }], { observedAt: at + day }), 1);
  assert.equal((await f.state()).items.find(item => item.slot === 'progress')?.expiresAt, new Date(at + 2 * day).toISOString());
  f.advance(day);
  assert.deepEqual((await f.state()).items, []);
});

test('memory commands are atomic, replay exact outcomes, preserve manual preferences and invalidate late learning', async () => {
  const f = setup(); await f.apply();
  const profile = f.rows('user_profiles').get(identity.dataOwnerId)!;
  profile.aiAssistant = { bjtu: { preferences: { goals: '保留手填目标', version: 1 } } };
  const result = await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'forget-command', question: '忘掉我的专业' });
  assert.equal(result.handled, true); assert.equal(result.changed, true);
  assert.equal((await f.state()).generation, 1); assert.deepEqual((await f.state()).items, []);
  assert.equal(await f.apply('late-command'), 0);
  assert.equal(await f.apply('new-learning', [major], { generation: 1 }), 1);
  assert.deepEqual(await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'forget-command', question: '忘掉我的专业' }), result);
  assert.equal((await f.state()).generation, 1);
  assert.equal((await f.state()).items.length, 1);
  assert.equal(f.rows('user_profiles').get(identity.dataOwnerId)!.aiAssistant.bjtu.preferences.goals, '保留手填目标');
  await assert.rejects(f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'forget-command', question: '清空自动记忆' }), { code: 'REQUEST_CONFLICT' });
});

test('clear major corrections and abandoned goals work while disabled correction cannot relearn', async () => {
  const f = setup(); await f.apply(); await f.apply('goal-for-command', [goalProposal('我准备考研')]);
  const corrected = await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'correct-command', question: '我现在是数学专业' });
  assert.equal(corrected.changed, true); assert.equal((await f.state()).items.find(item => item.slot === 'major')?.text, '我现在是数学专业');
  assert.equal((await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'abandon-command', question: '我现在不准备考研了' })).changed, true);
  assert.equal((await f.state()).items.some(item => item.slot === 'goal'), false);
  const state = await f.state(); await f.handle('ai.memory.configure', { enabled: false, version: state.version });
  const disabled = await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'disabled-correct', question: '我的专业改成物理' });
  assert.equal(disabled.handled, true);
  assert.equal((await f.state()).items.some(item => item.slot === 'major'), false);
  assert.equal((await f.state()).enabled, false);
  assert.equal((await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'disabled-clear', question: '清空自动记忆' })).handled, true);
});

test('hypothetical, quoted, negated and third-party commands never mutate; ambiguous and sensitive corrections clarify', async () => {
  for (const question of ['如果我说忘掉我的专业会怎样', '不要忘掉我的专业', '朋友说忘掉我的专业', '“忘掉我的专业”', '不要把目标考研改成实习', '假如我现在是数学专业']) {
    const f = setup(); await f.apply();
    const result = await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'non-command', question });
    assert.equal(result.handled, false, question); assert.equal((await f.state()).generation, 0); assert.equal((await f.state()).items.length, 1);
  }
  for (const question of ['忘掉那个目标', '把目标考研改成我的密码secret123', '我的专业改成邮箱test@example.com']) {
    const f = setup(); await f.apply();
    const result = await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'clarify-command', question });
    assert.equal(result.handled, true, question); assert.equal(result.changed, false); assert.ok(result.message); assert.equal((await f.state()).generation, 0);
  }
});

test('goal replacement is unique and cascades stale progress; concurrent command replays mutate once', async () => {
  const f = setup(); await f.apply('g1', [goalProposal('我准备考研')]);
  const goal = (await f.state()).items[0];
  const text = '我已完成报名'; await f.apply('p1', [{ slot: 'progress', text, evidence: text, goalId: goal.id }]);
  const input = { requestId: 'replace-command', question: '把目标考研改成准备实习' };
  const [first, replay] = await Promise.all([f.service.command(identity.dataOwnerId, 'bjtu', input), f.service.command(identity.dataOwnerId, 'bjtu', input)]);
  assert.deepEqual(first, replay); assert.equal(first.changed, true);
  const state = await f.state(); assert.equal(state.generation, 1); assert.equal(state.items.length, 1); assert.equal(state.items[0].id, goal.id); assert.match(state.items[0].text, /准备实习/);
  await assert.rejects(f.service.command(identity.dataOwnerId, 'other', input), { code: 'STALE_SCOPE' });
});

test('legacy progress is capped even before rewriting, and delayed progress cannot attach to a corrected goal', async () => {
  const f = setup(), stamp = new Date(at).toISOString();
  f.rows('user_profiles').get(identity.dataOwnerId)!.aiMemory = { bjtu: { items: [
    { id: 'goal', slot: 'goal', text: '我准备考研', createdAt: stamp, updatedAt: stamp, expiresAt: new Date(at + day).toISOString() },
    { id: 'progress', slot: 'progress', text: '我已完成报名', createdAt: stamp, updatedAt: stamp, expiresAt: new Date(at + 30 * day).toISOString() },
  ] } };
  f.advance(day); assert.deepEqual((await f.state()).items, []);
  const g = setup(); await g.apply('goal', [goalProposal('我准备考研')]);
  const goalId = (await g.state()).items[0].id;
  g.advance(2 * day);
  await g.apply('updated-goal', [goalProposal('我准备申请实习', goalId)], { observedAt: at + 2 * day });
  const text = '我已完成报名';
  assert.equal(await g.apply('late-stage', [{ slot: 'progress', text, evidence: text, goalId }], { observedAt: at + day }), 0);
});

test('questions and mixed instructions do not masquerade as explicit correction or abandonment', async () => {
  for (const question of ['我现在不准备考研了吗', '我的专业现在是数学吗', '我的专业是计算机专业吗', '我现在是数学专业，帮我看看公告', '我的专业是计算机专业还是数学专业', '我现在是数学专业的话能选什么课', '我的专业是数学专业有什么比赛']) {
    const f = setup(); await f.apply(); await f.apply('goal', [goalProposal('我准备考研')]);
    const before = await f.state();
    assert.equal((await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'not-directive', question })).handled, false, question);
    assert.deepEqual(await f.state(), before);
  }
});

test('shared generic goal words never authorize deleting a different named goal', async () => {
  const f = setup(); await f.apply('coding', [goalProposal('我想参加编程竞赛')]);
  const before = await f.state();
  const result = await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'different-goal', question: '忘掉目标数学竞赛' });
  assert.equal(result.changed, true, 'an explicit forget still fences older pending observations');
  const after = await f.state();
  assert.deepEqual(after.items, before.items);
  assert.equal(after.generation, before.generation + 1);
  assert.match(result.message!, /没有找到/);
});

test('explicit but incomplete slot operations clarify without deletion, including after an ambiguous replay', async () => {
  const f = setup(); await f.apply();
  const question = '忘掉我的专业和兴趣';
  const first = await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'incomplete-slots', question });
  assert.equal(first.handled, true); assert.equal(first.changed, false); assert.ok(first.message);
  assert.equal((await f.state()).generation, 0); assert.equal((await f.state()).items.length, 1);
  assert.deepEqual(await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'incomplete-slots', question }), first);
});

test('two goals in one successful round are independent and their progress never crosses goals', async () => {
  const f = setup();
  assert.equal(await f.apply('two-goals', [goalProposal('我准备考研'), goalProposal('我准备申请实习')]), 2);
  const [first, second] = (await f.state()).items;
  const text = '我已完成报名材料';
  assert.equal(await f.apply('two-stages', [{ slot: 'progress', text, evidence: text, goalId: first.id }, { slot: 'progress', text, evidence: text, goalId: second.id }]), 2);
  const state = await f.state();
  assert.equal(state.items.length, 4);
  const result = await f.handle('ai.memory.forget', { id: first.id, version: state.version });
  assert.deepEqual(result.items.map(item => item.goalId || item.id), [second.id, second.id]);
});

test('command receipts keep complete replay results beyond forty commands within 48h and expire by time', async () => {
  const f = setup(); await f.apply();
  const input = { requestId: 'retained-command', question: '忘掉我的专业' };
  const result = await f.service.command(identity.dataOwnerId, 'bjtu', input);
  await f.apply('after-command', [major], { generation: 1 });
  for (let i = 0; i < 45; i++) await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: `clarify-${i}`, question: '忘掉那个目标' });
  f.advance(47 * 3600000);
  assert.deepEqual(await f.service.command(identity.dataOwnerId, 'bjtu', input), result);
  assert.equal((await f.state()).items.length, 1);
  assert.equal((await f.state()).generation, 1);
  let receipts = f.rows('user_profiles').get(identity.dataOwnerId)!.aiMemory.bjtu.commandRequests;
  assert.equal(receipts.length, 46);
  assert.equal(receipts[0].at, new Date(at).toISOString());
  assert.equal(receipts[0].question, undefined);
  f.advance(3600000);
  await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'fresh-command', question: '忘掉我的年级' });
  receipts = f.rows('user_profiles').get(identity.dataOwnerId)!.aiMemory.bjtu.commandRequests;
  assert.deepEqual(receipts.map((entry: any) => entry.requestId), ['fresh-command']);
  assert.equal(receipts[0].at, new Date(at + 48 * 3600000).toISOString());
});

test('forgetting an absent slot or named goal fences in-flight learning without claiming to delete a stored item', async () => {
  for (const [question, proposal] of [
    ['忘掉我的专业', major],
    ['我现在不准备考研了', goalProposal('我准备考研')],
  ] as const) {
    const f = setup(), input = { requestId: 'absent-forget', question };
    const first = await f.service.command(identity.dataOwnerId, 'bjtu', input);
    assert.equal(first.handled, true); assert.equal(first.changed, true);
    assert.match(first.message!, /没有/);
    assert.equal((await f.state()).generation, 1);
    assert.equal(await f.apply('old-observation', [proposal]), 0);
    assert.deepEqual(await f.service.command(identity.dataOwnerId, 'bjtu', input), first);
    assert.equal((await f.state()).generation, 1);
    assert.deepEqual((await f.state()).items, []);
  }
});

test('ambiguous alternatives and conditional questions never replace goals or majors or clear their progress', async () => {
  for (const question of [
    '把目标考研改成准备实习还是准备保研',
    '把目标考研改成准备实习或准备保研',
    '把目标考研改成实习的话能做什么',
    '我的专业是计算机或数学',
    '我的专业改成计算机或数学',
    '我的专业改成数学的话能选什么课',
  ]) {
    const f = setup(); await f.apply(); await f.apply('g1', [goalProposal('我准备考研')]);
    const goalId = (await f.state()).items.find(item => item.slot === 'goal')!.id;
    const text = '我已完成报名材料';
    await f.apply('p1', [{ slot: 'progress', text, evidence: text, goalId }]);
    const before = await f.state();
    const result = await f.service.command(identity.dataOwnerId, 'bjtu', { requestId: 'ambiguous-correction', question });
    assert.notEqual(result.changed, true, question);
    assert.deepEqual(await f.state(), before, question);
    if (result.handled) assert.ok(result.message, 'ambiguous command must explain how to clarify');
  }
});
