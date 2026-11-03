import { afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import AiReadingSettings from '../src/components/AiReadingSettings.vue';
import type { AiChatTurn, AiConversation, AiProviderState, AiMemoryItem, AiMemoryState, AuthSession, Notice } from '@campus/contracts';
import type { Transport } from '../src/lib/transport';
import { ClientError } from '../src/lib/errors';
import * as markdown from '../src/lib/markdown';
const notice: Notice = { id: 'one', title: '校园招聘报名', sourceName: '就业中心', categories: ['career'], publishedAt: null, summary: '报名资料说明' };
const turn: AiChatTurn = { id: 'turn-1', question: '需要什么材料？', taskId: 'task-1', state: 'ready', result: null, message: '待处理', references: [{ reference: 'R1', itemId: 'one', title: notice.title, originalUrl: 'https://example.edu/notice' }], step: 0, totalSteps: 2, quotaHeld: true, service: 'official', provider: 'deepseek', model: 'chat' };
function conversation(turns: AiChatTurn[] = []): AiConversation { return { id: 'chat-1', schoolId: 'bjtu', createdAt: new Date().toISOString(), expireAt: new Date(Date.now() + 86400000).toISOString(), turns }; }
const memoryItem: AiMemoryItem = { id: 'goal', slot: 'goal', text: '我准备参加程序设计比赛', createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z', expiresAt: '2027-04-20T00:00:00Z' };
function memory(items: AiMemoryItem[] = []): AiMemoryState { return { schoolId: 'bjtu', enabled: true, version: 2, generation: 1, items }; }
function fakeTransport(override?: (action: string, input: any) => unknown): Transport {
  return { restore: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), onSessionChange: vi.fn(), call: vi.fn(async (action, input) => {
    const result = override?.(action, input); if (result !== undefined) return result;
    if (action === 'ai.status') return { quota: { day: '2026-10-19', timezone: 'Asia/Shanghai', limit: 3, used: 0, held: 0, remaining: 3, resetsAt: '' }, officialConfigured: true, officialModel: 'chat', providers: [] };
    if (action === 'ai.profile.get') return { schoolId: input.schoolId, interests: ['招聘'], goals: '', learningEnabled: false, version: 2 };
    if (action === 'ai.providers.list') return { storageConfigured: true, version: 0, profiles: [], selection: null };
    if (action === 'ai.memory.get') return { ...memory(), schoolId: input.schoolId };
    if (action === 'ai.recommend') return { items: [{ ...notice, originalUrl: 'https://example.edu/notice', reason: '与你关注的招聘相关', readState: 'title_only', checkedAt: null, allowAi: true }], search: { state: 'idle', message: '尚未搜索' }, coverage: '当前已收录公告' };
    if (action === 'ai.chat.latest') return { conversation: null };
    if (action === 'ai.chat.create') return conversation();
    if (action === 'ai.chat.send') return { ...turn, question: input.question };
    if (action === 'ai.chat.step') return { ...turn, state: 'complete', step: 2, result: '## 材料\n\n准备简历 [R1]', quotaHeld: false };
    if (action === 'ai.chat.get') return conversation();
    if (action === 'ai.profile.save') return { ...input, version: 3 };
    if (action === 'ai.dismiss') return { dismissed: input.dismissed };
    if (action === 'ai.behavior') return { recorded: false };
    throw new Error(`Unexpected ${action}`);
  }) as Transport['call'] };
}
const mounted: ReturnType<typeof mount>[] = [];
function open(fake: Transport, selection: Notice[] = []) { const w = mount(AiReadingSettings, { props: { transport: fake, schoolId: 'bjtu' } }); mounted.push(w); return w; }
afterEach(() => { mounted.splice(0).forEach(w => w.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); });

it('loads automatic memory independently from behavior learning without writing or asking for confirmation', async () => {
  const fake = fakeTransport(a => a === 'ai.memory.get' ? memory([memoryItem, { ...memoryItem, id: 'major', slot: 'major', text: '我是计算机专业', expiresAt: null }]) : undefined);
  const w = open(fake); await flushPromises();
  const section = w.get('[data-test="memory-section"]');
  expect(section.get('summary').text()).toBe('AI记住的信息');
  expect(section.text()).toContain('自动保存'); expect(section.text()).toContain('无需逐条确认');
  expect(section.text()).toContain('我准备参加程序设计比赛'); expect(section.text()).toContain('到期'); expect(section.text()).toContain('无固定到期');
  expect((section.get('[data-test="memory-enabled"]').element as HTMLInputElement).checked).toBe(true);
  expect((w.get('.learning-toggle input').element as HTMLInputElement).checked).toBe(false);
  expect(vi.mocked(fake.call).mock.calls.some(([action]) => ['ai.memory.configure', 'ai.memory.forget', 'ai.memory.clear', 'ai.profile.save'].includes(action))).toBe(false);
});
it('deletes an automatic memory immediately and clears only automatic memories on explicit clicks', async () => {
  const confirm = vi.spyOn(window, 'confirm');
  const fake = fakeTransport(a => a === 'ai.memory.get' ? memory([memoryItem, { ...memoryItem, id: 'major', slot: 'major', text: '我是计算机专业', expiresAt: null }]) : a === 'ai.memory.forget' ? { ...memory([{ ...memoryItem, id: 'major', slot: 'major', text: '我是计算机专业', expiresAt: null }]), version: 3 } : a === 'ai.memory.clear' ? { ...memory(), version: 4 } : undefined);
  const w = open(fake); await flushPromises();
  await w.get('[data-test="forget-memory-goal"]').trigger('click'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.memory.forget', { schoolId: 'bjtu', id: 'goal', version: 2 });
  expect(w.text()).not.toContain('我准备参加程序设计比赛'); expect(w.text()).toContain('我是计算机专业');
  await w.get('[data-test="clear-memory"]').trigger('click'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.memory.clear', { schoolId: 'bjtu', version: 3 });
  expect(w.text()).not.toContain('我是计算机专业'); expect(w.text()).toContain('暂无自动记忆'); expect(w.text()).toContain('手动偏好已保留');
  expect((w.get('#assistant-interests').element as HTMLInputElement).value).toBe('招聘'); expect(confirm).not.toHaveBeenCalled();
});
it('configures automatic memory from a user toggle without enabling behavior learning', async () => {
  const fake = fakeTransport((a, input) => a === 'ai.memory.configure' ? { ...memory(), enabled: input.enabled, version: 3 } : undefined);
  const w = open(fake); await flushPromises(); await w.get('[data-test="memory-enabled"]').setValue(false); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.memory.configure', { schoolId: 'bjtu', enabled: false, version: 2 });
  expect((w.get('[data-test="memory-enabled"]').element as HTMLInputElement).checked).toBe(false);
  expect(w.text()).toContain('已关闭自动记忆'); expect((w.get('.learning-toggle input').element as HTMLInputElement).checked).toBe(false);
  expect(vi.mocked(fake.call).mock.calls.some(([action]) => action === 'ai.profile.save')).toBe(false);
});
it.each(['configure', 'forget', 'clear'])('reloads memory after a %s version conflict without retrying the write', async action => {
  let reads = 0;
  const fake = fakeTransport(a => {
    if (a === 'ai.memory.get') return { ...memory(reads++ ? [{ ...memoryItem, text: '其他页面保存的新目标' }] : [memoryItem]), version: reads === 1 ? 2 : 7 };
    if (a === `ai.memory.${action}`) throw new ClientError('MEMORY_CONFLICT', '版本冲突');
  });
  const w = open(fake); await flushPromises();
  if (action === 'configure') await w.get('[data-test="memory-enabled"]').setValue(false);
  else await w.get(`[data-test="${action === 'forget' ? 'forget-memory-goal' : 'clear-memory'}"]`).trigger('click');
  await flushPromises(); expect(w.text()).toContain('其他页面保存的新目标'); expect(w.text()).toContain('已加载最新记忆');
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === `ai.memory.${action}`)).toHaveLength(1);
  expect((w.get('[data-test="memory-enabled"]').element as HTMLInputElement).checked).toBe(true);
});
it.each(['read', 'mutation'])('discards an old-school memory %s response after switching school', async operation => {
  let finish!: (value: AiMemoryState) => void;
  const pending = new Promise<AiMemoryState>(resolve => { finish = resolve; });
  const fake = fakeTransport((a, input) => {
    if (a === 'ai.memory.get') return input.schoolId === 'other' ? { ...memory([{ ...memoryItem, text: '新学校目标' }]), schoolId: 'other' } : operation === 'read' ? pending : memory([memoryItem]);
    if (a === 'ai.memory.clear') return pending;
  });
  const w = open(fake); await flushPromises();
  if (operation === 'mutation') { await w.get('[data-test="clear-memory"]').trigger('click'); await flushPromises(); }
  await w.setProps({ schoolId: 'other' }); await flushPromises(); finish(memory([{ ...memoryItem, text: '旧学校迟到记忆' }])); await flushPromises();
  expect(w.text()).toContain('新学校目标'); expect(w.text()).not.toContain('旧学校迟到记忆');
});
it('does not transfer a delayed memory response to the next account component', async () => {
  let finish!: (value: AiMemoryState) => void; const pending = new Promise<AiMemoryState>(resolve => { finish = resolve; });
  const old = open(fakeTransport(a => a === 'ai.memory.get' ? pending : undefined)); await flushPromises(); old.unmount();
  const next = open(fakeTransport(a => a === 'ai.memory.get' ? memory([{ ...memoryItem, text: '新账号目标' }]) : undefined)); await flushPromises();
  finish(memory([{ ...memoryItem, text: '旧账号私人目标' }])); await flushPromises();
  expect(next.text()).toContain('新账号目标'); expect(next.text()).not.toContain('旧账号私人目标');
});
it('keeps the authoritative memory toggle when configuration fails', async () => {
  const fake = fakeTransport(a => { if (a === 'ai.memory.configure') throw new Error('network unavailable'); });
  const w = open(fake); await flushPromises(); await w.get('[data-test="memory-enabled"]').setValue(false); await flushPromises();
  expect((w.get('[data-test="memory-enabled"]').element as HTMLInputElement).checked).toBe(true);
  expect(w.find('.error-message').exists()).toBe(true);
});
it('hides expired automatic memories on read and expiry without polling or starting another timer', async () => {
  vi.useFakeTimers(); const now = Date.now();
  const fake = fakeTransport(a => a === 'ai.memory.get' ? memory([
    { ...memoryItem, text: '已到期目标', expiresAt: new Date(now).toISOString() },
    { ...memoryItem, id: 'progress', slot: 'progress', text: '即将到期进展', expiresAt: new Date(now + 1000).toISOString() },
  ]) : undefined);
  const w = open(fake); await flushPromises(); expect(w.text()).not.toContain('已到期目标'); expect(w.text()).toContain('即将到期进展');
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1000); expect(w.text()).not.toContain('即将到期进展'); expect(w.text()).toContain('暂无自动记忆');
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.memory.get')).toHaveLength(1);
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => ['ai.memory.configure', 'ai.memory.forget', 'ai.memory.clear'].includes(a))).toBe(false);
});
it('profile version conflicts reload the latest version and allow the user to reapply edits', async () => {
  let reads = 0, saves = 0;
  const fake = fakeTransport((a, input) => {
    if (a === 'ai.profile.get') { reads++; return { schoolId: 'bjtu', interests: reads === 1 ? ['招聘'] : ['科研'], goals: '', learningEnabled: false, version: reads === 1 ? 2 : 7 }; }
    if (a === 'ai.profile.save') { saves++; if (saves === 1) throw new ClientError('PROFILE_CONFLICT', '版本冲突'); return { ...input, version: 8 }; }
  });
  const w = open(fake); await flushPromises(); await w.get('#assistant-interests').setValue('实习'); await w.get('[data-test="save-preferences"]').trigger('click'); await flushPromises();
  expect((w.get('#assistant-interests').element as HTMLInputElement).value).toBe('科研'); expect(w.text()).toContain('重新填写后保存');
  await w.get('#assistant-interests').setValue('实习'); await w.get('[data-test="save-preferences"]').trigger('click'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.profile.save', expect.objectContaining({ version: 7, interests: ['实习'] })); expect(w.text()).toContain('偏好已保存');
});
it('shows independent goals and identifies the goal belonging to each progress item', async () => {
  const items: AiMemoryItem[] = [
    { ...memoryItem, id: 'goal-exam', text: '准备考研' },
    { ...memoryItem, id: 'goal-work', text: '准备实习' },
    { ...memoryItem, id: 'progress-exam', slot: 'progress', text: '已复习数学第一章', goalId: 'goal-exam' },
    { ...memoryItem, id: 'progress-work', slot: 'progress', text: '已完成简历', goalId: 'goal-work' },
    { ...memoryItem, id: 'progress-unlinked', slot: 'progress', text: '旧版未关联进展' },
  ];
  const fake = fakeTransport(a => a === 'ai.memory.get' ? memory(items) : undefined);
  const w = open(fake); await flushPromises();
  const rows = w.findAll('.memory-list li');
  expect(rows).toHaveLength(5);
  expect(rows.find(row => row.text().includes('已复习数学第一章'))!.text()).toContain('所属目标：准备考研');
  expect(rows.find(row => row.text().includes('已完成简历'))!.text()).toContain('所属目标：准备实习');
  expect(rows.find(row => row.text().includes('旧版未关联进展'))!.text()).toContain('未关联目标');
  expect(rows.find(row => row.text().includes('准备考研'))!.text()).toContain('到期：');
});
it('deletes a goal using its actual stable string id without deleting a different goal', async () => {
  const exam = { ...memoryItem, id: 'goal-exam', text: '准备考研' }, work = { ...memoryItem, id: 'goal-work', text: '准备实习' };
  const fake = fakeTransport(a => a === 'ai.memory.get' ? memory([exam, work]) : a === 'ai.memory.forget' ? { ...memory([work]), version: 3 } : undefined);
  const w = open(fake); await flushPromises();
  await w.get('[data-test="forget-memory-goal-exam"]').trigger('click'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.memory.forget', { schoolId: 'bjtu', id: 'goal-exam', version: 2 });
  expect(w.get('.memory-list').text()).not.toContain('准备考研'); expect(w.get('.memory-list').text()).toContain('准备实习');
});
it('associates legacy progress with the legacy goal without guessing among new goals', async () => {
  const fake = fakeTransport(a => a === 'ai.memory.get' ? memory([memoryItem, { ...memoryItem, id: 'progress', slot: 'progress', text: '已开始训练' }]) : undefined);
  const w = open(fake); await flushPromises();
  expect(w.findAll('.memory-list li').find(row => row.text().includes('已开始训练'))!.text()).toContain(`所属目标：${memoryItem.text}`);
});
