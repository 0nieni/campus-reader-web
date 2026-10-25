import { afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import AssistantPanel from '../src/components/AssistantPanel.vue';
import type { AiChatTurn, AiConversation, AiMemoryItem, AiMemoryState, Notice } from '@campus/contracts';
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
function open(fake: Transport, selection: Notice[] = []) { const w = mount(AssistantPanel, { props: { transport: fake, schoolId: 'bjtu', selection } }); mounted.push(w); return w; }
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
it('refreshes automatic memories after an answer completes', async () => {
  let reads = 0;
  const fake = fakeTransport(a => a === 'ai.memory.get' ? memory(reads++ ? [memoryItem] : []) : undefined);
  const w = open(fake); await flushPromises(); expect(w.text()).not.toContain(memoryItem.text);
  await w.get('#assistant-question').setValue('我准备参加程序设计比赛'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('[data-test="memory-section"]').text()).toContain(memoryItem.text);
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.memory.get')).toHaveLength(2);
});
it('refreshes automatic memories after recovering a lost completed answer without a second model call', async () => {
  let reads = 0;
  const fake = fakeTransport(a => {
    if (a === 'ai.memory.get') return memory(reads++ ? [memoryItem] : []);
    if (a === 'ai.chat.step') throw new Error('response lost');
    if (a === 'ai.chat.get') return conversation([{ ...turn, state: 'complete', result: '已完成回答', quotaHeld: false }]);
  });
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('问题'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('[data-test="memory-section"]').text()).toContain(memoryItem.text); expect(w.text()).toContain('已完成回答');
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.chat.step')).toHaveLength(1);
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
it.each(['configure', 'forget', 'clear'])('refreshes recommendations after a successful memory %s', async action => {
  let changed = false;
  const fake = fakeTransport(a => {
    if (a === 'ai.memory.get') return memory([memoryItem]);
    if (a === `ai.memory.${action}`) { changed = true; return { ...memory(action === 'configure' ? [memoryItem] : []), enabled: action !== 'configure', version: 3 }; }
    if (a === 'ai.recommend') return { items: [{ ...notice, originalUrl: null, reason: changed ? '当前手动偏好推荐' : '基于自动记忆中的旧目标推荐', readState: 'title_only', checkedAt: null, allowAi: true }], search: { state: 'idle', message: '' }, coverage: '' };
  });
  const w = open(fake); await flushPromises(); expect(w.text()).toContain('基于自动记忆中的旧目标推荐');
  if (action === 'configure') await w.get('[data-test="memory-enabled"]').setValue(false);
  else await w.get(`[data-test="${action === 'forget' ? 'forget-memory-goal' : 'clear-memory'}"]`).trigger('click');
  await flushPromises(); expect(w.text()).not.toContain('基于自动记忆中的旧目标推荐'); expect(w.text()).toContain('当前手动偏好推荐');
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.recommend')).toHaveLength(2);
});
it.each(['configure', 'forget', 'clear'])('keeps a successful memory %s when its recommendation refresh fails', async action => {
  let changed = false;
  const fake = fakeTransport(a => {
    if (a === 'ai.memory.get') return memory([memoryItem]);
    if (a === `ai.memory.${action}`) { changed = true; return { ...memory(action === 'configure' ? [memoryItem] : []), enabled: action !== 'configure', version: 3 }; }
    if (a === 'ai.recommend' && changed) throw new Error('recommendation refresh unavailable');
  });
  const w = open(fake); await flushPromises();
  if (action === 'configure') await w.get('[data-test="memory-enabled"]').setValue(false);
  else await w.get(`[data-test="${action === 'forget' ? 'forget-memory-goal' : 'clear-memory'}"]`).trigger('click');
  await flushPromises();
  expect(w.find('.error-message').exists()).toBe(true); expect(w.text()).not.toContain('与你关注的招聘相关');
  if (action === 'configure') expect(w.text()).toContain(memoryItem.text); else expect(w.text()).not.toContain(memoryItem.text);
  expect((w.get('[data-test="memory-enabled"]').element as HTMLInputElement).checked).toBe(action !== 'configure');
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === `ai.memory.${action}`)).toHaveLength(1);
});
it('ignores an old-school recommendation refresh after a memory deletion', async () => {
  let finish!: (value: unknown) => void; const pending = new Promise(resolve => { finish = resolve; }); let changed = false;
  const fake = fakeTransport((a, input) => {
    if (a === 'ai.memory.get') return { ...memory([memoryItem]), schoolId: input.schoolId };
    if (a === 'ai.memory.forget') { changed = true; return { ...memory(), version: 3 }; }
    if (a === 'ai.recommend') {
      if (input.schoolId === 'bjtu' && changed) return pending;
      return { items: [{ ...notice, title: input.schoolId === 'other' ? '新学校推荐资料' : '原学校资料', originalUrl: null, reason: '当前推荐', readState: 'title_only', checkedAt: null, allowAi: true }], search: { state: 'idle', message: '' }, coverage: '' };
    }
  });
  const w = open(fake); await flushPromises(); await w.get('[data-test="forget-memory-goal"]').trigger('click'); await flushPromises();
  expect(w.find('.recommendation').exists()).toBe(false);
  await w.setProps({ schoolId: 'other' }); await flushPromises();
  finish({ items: [{ ...notice, title: '旧学校迟到推荐', originalUrl: null, reason: '旧理由', readState: 'title_only', checkedAt: null, allowAi: true }], search: { state: 'idle', message: '' }, coverage: '' }); await flushPromises();
  expect(w.text()).toContain('新学校推荐资料'); expect(w.text()).not.toContain('旧学校迟到推荐');
});
it('shows a nonblocking memory failure next to a successful answer without resending the model request', async () => {
  const fake = fakeTransport(a => a === 'ai.chat.step' ? { ...turn, state: 'complete', step: 2, result: '报名需要简历。', quotaHeld: false, memoryMessage: '本次回答已完成，自动记忆暂未保存。' } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('报名材料？'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('.markdown-content').text()).toContain('报名需要简历。'); expect(w.get('.turn-memory-status').text()).toContain('自动记忆暂未保存');
  expect(w.find('.error-message').exists()).toBe(false);
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.chat.send')).toHaveLength(1); expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.chat.step')).toHaveLength(1);
  await w.get('#assistant-question').setValue('下个问题'); expect(w.get('[data-test="send"]').attributes('disabled')).toBeUndefined();
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
it('opening loads factual context but never starts a conversation, searches or calls a model', async () => {
  const fake = fakeTransport(); const w = open(fake); await flushPromises();
  expect(w.text()).toContain('校园招聘报名'); expect(w.text()).toContain('仅标题'); expect(w.text()).toContain('与你关注的招聘相关');
  expect(fake.call).toHaveBeenCalledWith('ai.recommend', { schoolId: 'bjtu' });
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => ['ai.chat.create', 'ai.chat.send', 'ai.chat.step', 'ai.start'].includes(a))).toBe(false);
});
it('welcomes goal-oriented questions without promising ongoing monitoring or reminders', async () => {
  const fake = fakeTransport(); const w = open(fake); await flushPromises();
  const welcome = w.get('.assistant-welcome').text();
  expect(welcome).toContain('也可以说说你的目标');
  expect(welcome).toContain('需要时一起想想下一步');
  expect(welcome).not.toMatch(/一直盯着|自动提醒|随时通知|已经记住/);
  expect(vi.mocked(fake.call).mock.calls.some(([action]) => ['ai.chat.send', 'ai.chat.step'].includes(action))).toBe(false);
});
it('shows server search status with each reply even when a model omits that limitation', async () => {
  const result = { ...turn, state: 'complete' as const, quotaHeld: false, result: '报名需要简历。', search: { state: 'failed' as const, message: '本次联网搜索未完成，以下使用已有公告。' } };
  const fake = fakeTransport(action => action === 'ai.chat.latest' ? { conversation: conversation([result]) } : undefined);
  const w = open(fake); await flushPromises();
  expect(w.get('.conversation-turn .turn-search-status').text()).toContain('本次联网搜索未完成');
  expect(w.get('.markdown-content').text()).toContain('报名需要简历');
  expect(vi.mocked(fake.call).mock.calls.some(([action]) => ['ai.chat.send', 'ai.chat.step', 'ai.recommend'].includes(action) && action !== 'ai.recommend')).toBe(false);
});
it('a chat search releases the previous selection so the next followup can use the discovered announcement', async () => {
  const discovered = { ...turn, state: 'complete' as const, quotaHeld: false, question: '再找找本校比赛', result: '找到一条新比赛公告。', references: [{ reference: 'R1', itemId: 'new', title: '新比赛', originalUrl: 'https://example.edu/new' }], search: { state: 'complete' as const, message: '搜索已完成' } };
  const fake = fakeTransport(action => action === 'ai.chat.send' ? discovered : undefined);
  const w = open(fake, [notice]); await flushPromises();
  await w.get('#assistant-question').setValue('再找找本校比赛'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.emitted('remove')).toEqual([['one']]);
  await w.setProps({ selection: [] });
  await w.get('#assistant-question').setValue('它什么时候截止？'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  const sends = vi.mocked(fake.call).mock.calls.filter(([action]) => action === 'ai.chat.send');
  expect(sends[1]![1]).not.toHaveProperty('itemIds');
});
it('recovering a lost search response also releases the stale selection without resending', async () => {
  let requestId = '';
  const fake = fakeTransport((action, input) => {
    if (action === 'ai.chat.send') { requestId = input.requestId; throw new Error('lost response'); }
    if (action === 'ai.chat.get') return conversation([{ ...turn, id: requestId, search: { state: 'complete', message: '搜索已完成' } }]);
  });
  const w = open(fake, [notice]); await flushPromises();
  await w.get('#assistant-question').setValue('再找找本校比赛'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.emitted('remove')).toEqual([['one']]);
  expect(vi.mocked(fake.call).mock.calls.filter(([action]) => action === 'ai.chat.send')).toHaveLength(1);
});
it('explicit send includes selected sources and steps into a rendered answer; followups reuse the conversation', async () => {
  const fake = fakeTransport(); const w = open(fake, [notice]); await flushPromises();
  await w.get('#assistant-question').setValue('需要什么材料？'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.find('.markdown-content h2').text()).toBe('材料'); expect(w.text()).toContain('[R1]');
  expect(fake.call).toHaveBeenCalledWith('ai.chat.send', expect.objectContaining({ conversationId: 'chat-1', question: '需要什么材料？', itemIds: ['one'], service: 'official' }));
  await w.get('#assistant-question').setValue('截止日期呢？'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.chat.create')).toHaveLength(1);
});
it('exhausted official quota prevents sending while preferences and explicit search remain available', async () => {
  const fake = fakeTransport(a => a === 'ai.status' ? { quota: { limit: 3, remaining: 0, used: 3, held: 0 }, officialConfigured: true, officialModel: 'chat', providers: [] } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('你好'); expect(w.get('[data-test="send"]').attributes('disabled')).toBeDefined();
  await w.get('#assistant-interests').setValue('招聘，竞赛, 科研'); await w.get('#assistant-goals').setValue('寻找实习'); await w.get('[data-test="save-preferences"]').trigger('click'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.profile.save', { schoolId: 'bjtu', interests: ['招聘', '竞赛', '科研'], goals: '寻找实习', learningEnabled: false, version: 2 });
  await w.get('#assistant-search').setValue('实习'); await w.get('form.source-search').trigger('submit'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.recommend', { schoolId: 'bjtu', query: '实习', search: true });
});
it('changing schools discards an old pending conversation response', async () => {
  let finish!: (v: unknown) => void; const pending = new Promise(r => { finish = r; });
  const fake = fakeTransport((a, input) => a === 'ai.chat.latest' && input.schoolId === 'bjtu' ? pending : undefined);
  const w = open(fake); await flushPromises(); await w.setProps({ schoolId: 'other' }); await flushPromises();
  finish({ conversation: conversation([{ ...turn, state: 'complete', result: '不应出现的旧学校结果' }]) }); await flushPromises(); expect(w.text()).not.toContain('不应出现的旧学校结果');
});
it('a failed step reads status once and requires explicit continuation instead of repeating model calls', async () => {
  const fake = fakeTransport(a => { if (a === 'ai.chat.step') throw new Error('network'); if (a === 'ai.chat.get') return conversation([turn]); });
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('材料？'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.chat.step')).toHaveLength(1); expect(fake.call).toHaveBeenCalledWith('ai.chat.get', { conversationId: 'chat-1' }); expect(w.text()).toContain('继续回答');
});
it('cancellation stops subsequent ready batches even when an in-flight step later returns', async () => {
  let finish!: (v: unknown) => void; const pending = new Promise(r => { finish = r; });
  const fake = fakeTransport(a => a === 'ai.chat.step' ? pending : a === 'ai.chat.cancel' ? { ...turn, state: 'cancelled' } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('材料？'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  await w.get('[data-test="cancel"]').trigger('click'); await flushPromises(); finish({ ...turn, step: 1 }); await flushPromises();
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.chat.step')).toHaveLength(1); expect(w.text()).toContain('已取消');
});
it('BYOK key only enters steps and disappears after leaving; expired results leave the page', async () => {
  vi.useFakeTimers(); const expires = new Date(Date.now() + 1000).toISOString();
  const fake = fakeTransport(a => a === 'ai.chat.create' ? { ...conversation(), expireAt: expires } : a === 'ai.chat.send' ? { ...turn, service: 'byok', model: 'my-model', quotaHeld: false } : undefined);
  const w = open(fake); await flushPromises(); await w.get('input[value="byok"]').setValue(); await w.get('#assistant-model').setValue('my-model'); await w.get('#assistant-key').setValue('memory-key'); await w.get('#assistant-question').setValue('材料？'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.chat.step', expect.objectContaining({ connection: { provider: 'deepseek', model: 'my-model', apiKey: 'memory-key' } }));
  expect(JSON.stringify(vi.mocked(fake.call).mock.calls.filter(([a]) => a !== 'ai.chat.step'))).not.toContain('memory-key');
  expect(w.text()).toContain('准备简历'); await vi.advanceTimersByTimeAsync(1000); expect(w.text()).not.toContain('准备简历'); w.unmount();
  const reopened = open(fake); await flushPromises(); await reopened.get('input[value="byok"]').setValue(); expect((reopened.get('#assistant-key').element as HTMLInputElement).value).toBe('');
});
it('ambiguous send retries retain the idempotency key and edited questions get a new one', async () => {
  const fake = fakeTransport(a => { if (a === 'ai.chat.send') throw new Error('lost reply'); });
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('相同问题'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises(); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  const sends = () => vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.chat.send').map(([, p]) => p as { requestId: string });
  expect(sends()).toHaveLength(2); expect(sends()[0]!.requestId).toBe(sends()[1]!.requestId);
  await w.get('#assistant-question').setValue('编辑后的问题'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises(); expect(sends()[2]!.requestId).not.toBe(sends()[0]!.requestId);
});
it('dismissing a recommendation can be undone and a card selection becomes chat context', async () => {
  const fake = fakeTransport(); const w = open(fake); await flushPromises(); await w.get('[data-test="select-source"]').trigger('click');
  await w.get('#assistant-question').setValue('具体报名要求'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises(); expect(fake.call).toHaveBeenCalledWith('ai.chat.send', expect.objectContaining({ itemIds: ['one'] }));
  await w.get('[data-test="dismiss-source"]').trigger('click'); await flushPromises(); expect(w.find('[data-test="select-source"]').exists()).toBe(false);
  await w.get('[data-test="undo-dismiss"]').trigger('click'); await flushPromises(); expect(w.find('[data-test="select-source"]').exists()).toBe(true); expect(fake.call).toHaveBeenCalledWith('ai.dismiss', { schoolId: 'bjtu', itemId: 'one', dismissed: false });
});
it('unknown send restores its exact turn and does not resend or step until requested', async () => {
  let lostId = '';
  const fake = fakeTransport((a, input) => {
    if (a === 'ai.chat.send') { lostId = input.requestId; throw new Error('lost response'); }
    if (a === 'ai.chat.get') return conversation([{ ...turn, id: lostId }]);
  });
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('材料？'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.text()).toContain('继续回答'); expect((w.get('#assistant-question').element as HTMLTextAreaElement).value).toBe('');
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.chat.send')).toHaveLength(1); expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.step')).toBe(false);
});
it('restoring BYOK uses the recorded model and requires re-entering the key before a manual continuation', async () => {
  const oldTurn = { ...turn, service: 'byok' as const, provider: 'openai', model: 'original-model', quotaHeld: false };
  const fake = fakeTransport(a => a === 'ai.chat.latest' ? { conversation: conversation([oldTurn]) } : undefined);
  const w = open(fake); await flushPromises();
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.step')).toBe(false);
  expect((w.get('#assistant-model').element as HTMLInputElement).value).toBe('original-model');
  expect((w.get('#assistant-key').element as HTMLInputElement).value).toBe('');
});
it('uncertain held quota is settled only after an explicit charged or not-charged choice', async () => {
  const heldTurn = { ...turn, state: 'uncertain' as const };
  const fake = fakeTransport(a => a === 'ai.chat.latest' ? { conversation: conversation([heldTurn]) } : a === 'ai.chat.resolve' ? { ...heldTurn, quotaHeld: false } : undefined);
  const w = open(fake); await flushPromises(); expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.resolve')).toBe(false);
  await w.get('#resolve-turn-1').setValue('not_charged'); await w.findAll('button').find(b => b.text() === '确认结算')!.trigger('click'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.chat.resolve', { conversationId: 'chat-1', turnId: 'turn-1', charged: false }); expect(w.find('#resolve-turn-1').exists()).toBe(false);
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => ['ai.chat.send', 'ai.chat.step'].includes(a))).toBe(false);
});
it('source selection records only an explicit action and respects the server opt-out without enabling learning', async () => {
  const fake = fakeTransport(); const w = open(fake); await flushPromises();
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.behavior')).toBe(false);
  await w.get('[data-test="select-source"]').trigger('click'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.behavior', { schoolId: 'bjtu', itemId: 'one' });
  expect((w.get('.learning-toggle input').element as HTMLInputElement).checked).toBe(false);
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.profile.save')).toBe(false);
});
it('a late rejected old-school step cannot pause the new school active batch loop', async () => {
  let rejectOld!: (reason: Error) => void, finishNew!: (value: AiChatTurn) => void;
  const oldStep = new Promise<AiChatTurn>((_, reject) => { rejectOld = reject; });
  const newStep = new Promise<AiChatTurn>(resolve => { finishNew = resolve; });
  const fake = fakeTransport((a, input) => {
    if (a === 'ai.chat.create') return { ...conversation(), id: `chat-${input.schoolId}`, schoolId: input.schoolId };
    if (a === 'ai.chat.send') return { ...turn, id: `turn-${input.conversationId}`, question: input.question };
    if (a === 'ai.chat.step') {
      if (input.conversationId === 'chat-bjtu') return oldStep;
      if (input.step === 0) return newStep;
      return { ...turn, id: 'turn-chat-other', step: 2, state: 'complete', result: '新学校回答已完成', quotaHeld: false };
    }
  });
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('旧学校问题'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  await w.setProps({ schoolId: 'other' }); await flushPromises(); await w.get('#assistant-question').setValue('新学校问题'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  rejectOld(new Error('old school request failed late')); await flushPromises();
  finishNew({ ...turn, id: 'turn-chat-other', step: 1 }); await flushPromises();
  expect(w.text()).toContain('新学校回答已完成');
  expect(vi.mocked(fake.call).mock.calls.filter(([a, input]) => a === 'ai.chat.step' && (input as any).conversationId === 'chat-other')).toHaveLength(2);
});
it('switching school during error recovery cannot write old notices into the new school', async () => {
  let finishRecovery!: (value: AiConversation) => void;
  const recovery = new Promise<AiConversation>(resolve => { finishRecovery = resolve; });
  const fake = fakeTransport(a => {
    if (a === 'ai.chat.step') throw new Error('request failed');
    if (a === 'ai.chat.get') return recovery;
  });
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('旧学校问题'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.chat.get', { conversationId: 'chat-1' });
  await w.setProps({ schoolId: 'other' }); await flushPromises();
  finishRecovery(conversation([turn])); await flushPromises();
  expect(w.text()).not.toContain('已查询对话状态'); expect(w.text()).not.toContain('旧学校问题'); expect(w.find('.error-message').exists()).toBe(false);
});
it.each(['save', 'clear'])('refreshes recommendation reasons after preferences %s succeeds', async action => {
  let changed = false;
  const fake = fakeTransport(a => {
    if (a === 'ai.profile.save') changed = true;
    if (a === 'ai.profile.clearBehavior') { changed = true; return { schoolId: 'bjtu', interests: ['招聘'], goals: '', learningEnabled: false, version: 3 }; }
    if (a === 'ai.recommend') return { items: [{ ...notice, originalUrl: null, reason: changed ? '当前手动偏好推荐' : '旧行为学习推荐理由', readState: 'title_only', checkedAt: null, allowAi: true }], search: { state: 'idle', message: '' }, coverage: '已收录公告' };
  });
  const w = open(fake); await flushPromises(); expect(w.text()).toContain('旧行为学习推荐理由');
  if (action === 'save') await w.get('[data-test="save-preferences"]').trigger('click');
  else await w.findAll('button').find(b => b.text() === '清除行为记录')!.trigger('click');
  await flushPromises(); expect(w.text()).not.toContain('旧行为学习推荐理由'); expect(w.text()).toContain('当前手动偏好推荐');
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.recommend')).toHaveLength(2);
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
it('a pending refreshed recommendation cannot overwrite the next school recommendation', async () => {
  let recCalls = 0, finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const fake = fakeTransport((a, input) => {
    if (a === 'ai.recommend') { recCalls++; if (recCalls === 2) return pending; if (input.schoolId === 'other') return { items: [{ ...notice, title: '新学校推荐', originalUrl: null, reason: '本校资料', readState: 'title_only', checkedAt: null, allowAi: true }], search: { state: 'idle', message: '' }, coverage: '新学校' }; }
  });
  const w = open(fake); await flushPromises(); await w.get('[data-test="save-preferences"]').trigger('click'); await flushPromises();
  await w.setProps({ schoolId: 'other' }); await flushPromises();
  finish({ items: [{ ...notice, title: '过时旧推荐', originalUrl: null, reason: '旧学校资料', readState: 'title_only', checkedAt: null, allowAi: true }], search: { state: 'idle', message: '' }, coverage: '旧学校' }); await flushPromises();
  expect(w.text()).toContain('新学校推荐'); expect(w.text()).not.toContain('过时旧推荐');
});
it('source cards explicitly show publication and body-check dates, including missing dates', async () => {
  const fake = fakeTransport(a => a === 'ai.recommend' ? { items: [{ ...notice, publishedAt: '2026-10-18T01:00:00Z', originalUrl: null, reason: '相关公告', readState: 'title_only', checkedAt: null, allowAi: true }], search: { state: 'idle', message: '' }, coverage: '' } : undefined);
  const w = open(fake); await flushPromises(); expect(w.get('.source-dates').text()).toContain('发布时间：2026/10/18'); expect(w.get('.source-dates').text()).toContain('正文检查：未提供');
});
it('exports the current conversation answers and references without keys or extending expiry', async () => {
  vi.useFakeTimers(); const snapshot = { ...conversation([{ ...turn, state: 'complete' as const, result: '准备简历 [R1]', quotaHeld: false }]), expireAt: new Date(Date.now() + 1000).toISOString() };
  const download = vi.spyOn(markdown, 'downloadFile').mockImplementation(() => {});
  const fake = fakeTransport(a => a === 'ai.chat.latest' ? { conversation: snapshot } : undefined); const w = open(fake); await flushPromises();
  await w.get('input[value="byok"]').setValue(); await w.get('#assistant-key').setValue('private-export-key');
  await w.get('[data-test="export-conversation"]').trigger('click');
  expect(download).toHaveBeenCalledTimes(1); const [filename, content] = download.mock.calls[0]!;
  expect(filename).toMatch(/\.md$/); expect(content).toContain('需要什么材料？'); expect(content).toContain('准备简历 [R1]'); expect(content).toContain('https://example.edu/notice'); expect(content).not.toContain('private-export-key');
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => ['ai.chat.send', 'ai.chat.step', 'ai.chat.create'].includes(a))).toBe(false);
  await vi.advanceTimersByTimeAsync(1000); expect(w.text()).not.toContain('准备简历 [R1]'); expect(w.get('[data-test="export-conversation"]').attributes('disabled')).toBeDefined();
});
it('a revoked-source failed turn with held quota can cancel and then resolve the held charge', async () => {
  const revoked = { ...turn, state: 'failed' as const, message: '资料已撤销 AI 阅读授权', quotaHeld: true };
  const fake = fakeTransport(a => a === 'ai.chat.latest' ? { conversation: conversation([revoked]) } : a === 'ai.chat.cancel' ? { ...revoked, state: 'cancelled', quotaHeld: true } : a === 'ai.chat.resolve' ? { ...revoked, state: 'cancelled', quotaHeld: false } : undefined);
  const w = open(fake); await flushPromises(); expect(w.text()).toContain('资料已撤销 AI 阅读授权');
  expect(w.findAll('button').some(button => button.text() === '刷新对话状态')).toBe(true);
  await w.get('[data-test="cancel"]').trigger('click'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.chat.cancel', { conversationId: 'chat-1', turnId: 'turn-1' });
  await w.get('#resolve-turn-1').setValue('not_charged'); await w.findAll('button').find(button => button.text() === '确认结算')!.trigger('click'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.chat.resolve', { conversationId: 'chat-1', turnId: 'turn-1', charged: false });
  await w.get('#assistant-question').setValue('换一个问题'); expect(w.get('[data-test="send"]').attributes('disabled')).toBeUndefined();
  expect(vi.mocked(fake.call).mock.calls.some(([action]) => ['ai.chat.send', 'ai.chat.step'].includes(action))).toBe(false);
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
it.each([
  '忘掉我的专业', '清空自动记忆', '我现在不准备考研了', '把目标考研改成准备实习', '我的专业改成数学专业',
])('sends the explicit memory command %s without a configured model or available quota', async command => {
  const fake = fakeTransport(a => a === 'ai.status' ? { quota: { limit: 3, remaining: 0, used: 3, held: 0 }, officialConfigured: false, officialModel: '', providers: [] }
    : a === 'ai.chat.send' ? { ...turn, taskId: null, state: 'complete', result: '已处理自动记忆。', quotaHeld: false, references: [] } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue(command);
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeUndefined();
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('.markdown-content').text()).toContain('已处理自动记忆');
  expect(fake.call).toHaveBeenCalledWith('ai.chat.send', expect.objectContaining({ question: command, service: 'official' }));
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.step')).toBe(false);
});
it('sends a memory command with BYOK selected and no credentials, leaving ordinary BYOK questions guarded', async () => {
  const fake = fakeTransport(a => a === 'ai.chat.send' ? { ...turn, taskId: null, state: 'complete', result: '已忘记专业。', quotaHeld: false } : undefined);
  const w = open(fake); await flushPromises(); await w.get('input[value="byok"]').setValue();
  await w.get('#assistant-question').setValue('需要什么材料？'); expect(w.get('[data-test="send"]').attributes('disabled')).toBeDefined();
  await w.get('#assistant-question').setValue('忘掉我的专业'); expect(w.get('[data-test="send"]').attributes('disabled')).toBeUndefined();
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('.markdown-content').text()).toContain('已忘记专业');
  const input = vi.mocked(fake.call).mock.calls.find(([a]) => a === 'ai.chat.send')![1];
  expect(input).toMatchObject({ service: 'official' }); expect(input).not.toHaveProperty('model'); expect(input).not.toHaveProperty('provider');
});
it.each([
  '需要什么材料？', '我不想忘掉我的专业', '如果我说忘掉我的专业会怎样', '“忘掉我的专业”是什么意思',
  '朋友说忘掉我的专业', '我现在不准备考研了吗？', '把目标考研改成准备实习有什么建议', '我的专业改成数学专业后该选什么课？',
])('keeps the ordinary or non-actionable question %s blocked without official quota', async question => {
  const fake = fakeTransport(a => a === 'ai.status' ? { quota: { limit: 3, remaining: 0, used: 3, held: 0 }, officialConfigured: true, officialModel: 'chat', providers: [] } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue(question);
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeDefined();
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.send')).toBe(false);
});
it('waits for command completion before refreshing authoritative memory and recommendation reasons', async () => {
  let finish!: (value: AiChatTurn) => void, changed = false;
  const pending = new Promise<AiChatTurn>(resolve => { finish = resolve; });
  const confirm = vi.spyOn(window, 'confirm');
  const fake = fakeTransport(a => {
    if (a === 'ai.memory.get') return memory(changed ? [] : [memoryItem]);
    if (a === 'ai.recommend') return { items: [{ ...notice, originalUrl: null, reason: changed ? '当前手动偏好推荐' : '自动记忆中的旧目标推荐', readState: 'title_only', checkedAt: null, allowAi: true }], search: { state: 'idle', message: '' }, coverage: '' };
    if (a === 'ai.chat.send') return pending;
  });
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('忘掉我的目标');
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('.memory-list').text()).toContain(memoryItem.text);
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeDefined();
  changed = true; finish({ ...turn, taskId: null, state: 'complete', quotaHeld: false, result: '已忘记这个目标。' }); await flushPromises();
  expect(w.get('.markdown-content').text()).toContain('已忘记这个目标');
  expect(w.text()).not.toContain(memoryItem.text); expect(w.text()).not.toContain('自动记忆中的旧目标推荐'); expect(w.text()).toContain('当前手动偏好推荐');
  expect(confirm).not.toHaveBeenCalled();
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => ['ai.memory.clear', 'ai.memory.forget', 'ai.memory.configure'].includes(a))).toBe(false);
});
it('shows an ambiguous command clarification without claiming a deletion or changing local memory', async () => {
  const fake = fakeTransport(a => a === 'ai.memory.get' ? memory([memoryItem])
    : a === 'ai.chat.send' ? { ...turn, taskId: null, state: 'complete', result: '请说明要忘记哪一个目标。', quotaHeld: false } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('忘掉我的目标');
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('.markdown-content').text()).toContain('请说明要忘记哪一个目标');
  expect(w.get('.memory-list').text()).toContain(memoryItem.text); expect(w.text()).not.toContain('已删除这条自动记忆');
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => ['ai.memory.clear', 'ai.memory.forget', 'ai.chat.step'].includes(a))).toBe(false);
});
it('preserves a completed command when recommendation refresh fails instead of recovering or resending it', async () => {
  let completed = false;
  const fake = fakeTransport(a => {
    if (a === 'ai.chat.send') { completed = true; return { ...turn, taskId: null, state: 'complete', quotaHeld: false, result: '已清空自动记忆。' }; }
    if (a === 'ai.memory.get') return memory(completed ? [] : [memoryItem]);
    if (a === 'ai.recommend' && completed) throw new Error('recommendation unavailable');
  });
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('清空自动记忆');
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('.markdown-content').text()).toContain('已清空自动记忆'); expect(w.text()).not.toContain(memoryItem.text); expect(w.find('.error-message').exists()).toBe(true);
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => ['ai.chat.get', 'ai.chat.step'].includes(a))).toBe(false);
});
it('associates legacy progress with the legacy goal without guessing among new goals', async () => {
  const fake = fakeTransport(a => a === 'ai.memory.get' ? memory([memoryItem, { ...memoryItem, id: 'progress', slot: 'progress', text: '已开始训练' }]) : undefined);
  const w = open(fake); await flushPromises();
  expect(w.findAll('.memory-list li').find(row => row.text().includes('已开始训练'))!.text()).toContain(`所属目标：${memoryItem.text}`);
});
it('keeps memory commands blocked while an existing turn holds quota or is unfinished', async () => {
  const fake = fakeTransport(a => a === 'ai.chat.latest' ? { conversation: conversation([{ ...turn, state: 'uncertain' }]) } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('忘掉我的专业');
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeDefined();
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.send')).toBe(false);
});
it('discards a completed old-school command before refreshing memory or recommendation reasons', async () => {
  let finish!: (value: AiChatTurn) => void;
  const pending = new Promise<AiChatTurn>(resolve => { finish = resolve; });
  const fake = fakeTransport((a, input) => a === 'ai.chat.send' ? pending : a === 'ai.memory.get' ? { ...memory([{ ...memoryItem, text: input.schoolId === 'other' ? '新学校目标' : '旧学校目标' }]), schoolId: input.schoolId } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('忘掉我的目标');
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  await w.setProps({ schoolId: 'other' }); await flushPromises();
  finish({ ...turn, taskId: null, state: 'complete', quotaHeld: false, result: '旧学校目标已删除。' }); await flushPromises();
  expect(w.text()).toContain('新学校目标'); expect(w.text()).not.toContain('旧学校目标已删除');
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.memory.get')).toHaveLength(2);
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.recommend')).toHaveLength(2);
});
it.each([
  '忘掉目标考研', '忘记目标考研', '删除目标考研', '清除目标考研',
  '忘掉我的目标考研', '忘记我的目标考研', '删除我的目标考研', '清除我的目标考研',
])('allows the named goal command %s with zero quota and no configured model', async command => {
  const fake = fakeTransport(a => a === 'ai.status' ? { quota: { limit: 3, remaining: 0, used: 3, held: 0 }, officialConfigured: false, officialModel: '', providers: [] }
    : a === 'ai.chat.send' ? { ...turn, taskId: null, state: 'complete', result: '已删除考研目标，其他目标保留。', quotaHeld: false } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue(command);
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeUndefined();
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('.markdown-content').text()).toContain('其他目标保留');
  expect(fake.call).toHaveBeenCalledWith('ai.chat.send', expect.objectContaining({ question: command, service: 'official' }));
});
it.each([
  '忘掉目标考研有什么后果', '忘掉目标考研是不是合理', '忘掉目标考研可以吗？',
  '“忘掉目标考研”', '`忘掉目标考研`', '朋友让我忘掉目标考研', '忘掉目标考研是朋友说的',
  '如果我忘掉目标考研', '假设忘掉目标考研', '不要忘掉目标考研', '我不想忘掉目标考研',
])('does not treat the non-direct named goal statement %s as a free command', async question => {
  const fake = fakeTransport(a => a === 'ai.status' ? { quota: { limit: 3, remaining: 0, used: 3, held: 0 }, officialConfigured: false, officialModel: '', providers: [] } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue(question);
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeDefined();
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.send')).toBe(false);
});
it('refreshes recommendations after recovering a lost completed program command response', async () => {
  let recovered = false;
  const fake = fakeTransport(a => {
    if (a === 'ai.chat.send') throw new Error('command response lost');
    if (a === 'ai.chat.get') { recovered = true; return conversation([{ ...turn, taskId: null, state: 'complete', result: '已删除考研目标。', quotaHeld: false }]); }
    if (a === 'ai.memory.get') return memory(recovered ? [] : [memoryItem]);
    if (a === 'ai.recommend') return { items: [{ ...notice, originalUrl: null, reason: recovered ? '当前手动偏好推荐' : '恢复前的旧目标推荐', readState: 'title_only', checkedAt: null, allowAi: true }], search: { state: 'idle', message: '' }, coverage: '' };
  });
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('忘掉我的目标');
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('.markdown-content').text()).toContain('已删除考研目标');
  expect(w.text()).not.toContain(memoryItem.text); expect(w.text()).not.toContain('恢复前的旧目标推荐'); expect(w.text()).toContain('当前手动偏好推荐');
  expect(fake.call).toHaveBeenCalledWith('ai.chat.get', { conversationId: 'chat-1' });
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.recommend')).toHaveLength(2);
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.chat.send')).toHaveLength(1);
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.step')).toBe(false);
});
