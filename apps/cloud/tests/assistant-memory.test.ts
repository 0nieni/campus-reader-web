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
  for (const operation of ['apply', 'configure']) {
    const f = setup(), start = f.db.startTransaction.bind(f.db);
    f.db.startTransaction = async () => {
      f.rows('user_profiles').get(identity.dataOwnerId)!.selectedSchoolId = 'other';
      return start();
    };
    if (operation === 'apply') await assert.rejects(f.apply(), { code: 'STALE_SCOPE' });
    else await assert.rejects(f.handle('ai.memory.configure', { enabled: false, version: 0 }), { code: 'STALE_SCOPE' });
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
