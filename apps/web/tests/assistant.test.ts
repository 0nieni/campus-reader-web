import { afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import AssistantPanel from '../src/components/AssistantPanel.vue';
import type { AiChatTurn, AiConversation, AiProviderState, AuthSession, Notice } from '@campus/contracts';
import type { Transport } from '../src/lib/transport';
import { ClientError } from '../src/lib/errors';
import * as markdown from '../src/lib/markdown';
const notice: Notice = { id: 'one', title: '校园招聘报名', sourceName: '就业中心', categories: ['career'], publishedAt: null, summary: '报名资料说明' };
const turn: AiChatTurn = { id: 'turn-1', question: '需要什么材料？', taskId: 'task-1', state: 'ready', result: null, message: '待处理', references: [{ reference: 'R1', itemId: 'one', title: notice.title, originalUrl: 'https://example.edu/notice' }], step: 0, totalSteps: 2, quotaHeld: true, service: 'official', provider: 'deepseek', model: 'chat' };
function conversation(turns: AiChatTurn[] = []): AiConversation { return { id: 'chat-1', schoolId: 'bjtu', createdAt: new Date().toISOString(), expireAt: new Date(Date.now() + 86400000).toISOString(), turns }; }
function fakeTransport(override?: (action: string, input: any) => unknown): Transport {
  return { restore: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), onSessionChange: vi.fn(), call: vi.fn(async (action, input) => {
    const result = override?.(action, input); if (result !== undefined) return result;
    if (action === 'ai.status') return { quota: { day: '2026-10-19', timezone: 'Asia/Shanghai', limit: 3, used: 0, held: 0, remaining: 3, resetsAt: '' }, officialConfigured: true, officialModel: 'chat', providers: [] };
    if (action === 'ai.profile.get') return { schoolId: input.schoolId, interests: ['招聘'], goals: '', learningEnabled: false, version: 2 };
    if (action === 'ai.providers.list') return { storageConfigured: true, version: 0, profiles: [], selection: null };
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

const savedState: AiProviderState = { storageConfigured: true, version: 4, profiles: [{ id: 'personal-1', name: '我的阅读接口', protocol: 'openai-chat', baseUrl: 'https://example.com/v1', models: ['personal-model', 'second-model'], defaultModel: 'personal-model', version: 2, keySaved: true, updatedAt: new Date().toISOString() }], selection: { profile: { id: 'personal-1', version: 2 }, model: 'personal-model' } };
it('account-dialog model changes preserve conversation and quota state without starting or replaying an answer',async()=>{
 let state=structuredClone(savedState);const previous={...turn,state:'complete' as const,quotaHeld:false,result:'保留的旧回答'};
 const fake=fakeTransport(action=>action==='ai.providers.list'?structuredClone(state):action==='ai.chat.latest'?{conversation:conversation([previous])}:undefined),w=open(fake);await flushPromises();
 state={...state,version:5,selection:{profile:{id:'personal-1',version:2},model:'second-model'}};
 await w.setProps({providerChange:{state:structuredClone(state),activate:'saved'}});await flushPromises();expect(w.text()).toContain('保留的旧回答');expect(w.text()).toContain('已选个人模型：second-model');
 expect(vi.mocked(fake.call).mock.calls.filter(([a])=>a==='ai.status')).toHaveLength(1);expect(vi.mocked(fake.call).mock.calls.some(([a])=>['ai.chat.create','ai.chat.send','ai.chat.step'].includes(a))).toBe(false);
 state={...state,version:6,selection:null};await w.setProps({providerChange:{state:structuredClone(state),activate:'official'}});await flushPromises();expect((w.get('input[value="official"]').element as HTMLInputElement).checked).toBe(true);expect(w.text()).toContain('保留的旧回答');
});
it('an uncertain personal call can explicitly end after checking usage without replaying the request', async () => {
  const unknown = { ...turn, state: 'uncertain' as const, quotaHeld: false, service: 'byok' as const, providerProfile: { id: 'personal-1', version: 2 } };
  const fake = fakeTransport(action => action === 'ai.providers.list' ? structuredClone(savedState) : action === 'ai.chat.latest' ? { conversation: conversation([unknown]) } : action === 'ai.chat.cancel' ? { ...unknown, state: 'cancelled' } : undefined);
  const w = open(fake); await flushPromises(); expect(w.text()).toContain('请先到服务商控制台核查用量');
  expect(w.get('[data-test="cancel"]').text()).toContain('已核查用量，结束本轮');
  await w.get('[data-test="cancel"]').trigger('click'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.chat.cancel', { conversationId: 'chat-1', turnId: turn.id });
  await w.get('#assistant-question').setValue('新的问题'); expect(w.get('[data-test="send"]').attributes('disabled')).toBeUndefined();
  expect(vi.mocked(fake.call).mock.calls.some(([action]) => ['ai.chat.send', 'ai.chat.step'].includes(action))).toBe(false);
});
it('choosing official AI clears the persisted personal selection without making a model call', async () => {
  const fake = fakeTransport(action => action === 'ai.providers.list' ? structuredClone(savedState) : action === 'ai.providers.select' ? { ...structuredClone(savedState), version: 5, selection: null } : undefined);
  const w = open(fake); await flushPromises(); await w.get('input[value="official"]').setValue(); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.providers.select', { id: null, version: 4 });
  expect((w.get('input[value="official"]').element as HTMLInputElement).checked).toBe(true);
  expect(vi.mocked(fake.call).mock.calls.some(([action]) => ['ai.chat.send', 'ai.chat.step'].includes(action))).toBe(false);
});
it('restores the personal selection and sends only its reference while saved-provider steps need no key', async () => {
  const personal = { ...turn, service: 'byok' as const, provider: 'openai-chat', model: 'personal-model', providerProfile: { id: 'personal-1', version: 2 }, quotaHeld: false };
  const fake = fakeTransport((action, input) => action === 'ai.providers.list' ? structuredClone(savedState) : action === 'ai.chat.send' ? { ...personal, question: input.question } : action === 'ai.chat.step' ? { ...personal, state: 'complete', step: 2, result: '个人接口回答' } : undefined);
  const w = open(fake); await flushPromises();
  expect((w.get('input[value="byok"]').element as HTMLInputElement).checked).toBe(true);
  await w.get('#assistant-question').setValue('请说明资料'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.chat.send', expect.objectContaining({ service: 'byok', providerProfile: { id: 'personal-1', version: 2 }, model: 'personal-model' }));
  const sendInput = vi.mocked(fake.call).mock.calls.find(([action]) => action === 'ai.chat.send')![1];
  expect(sendInput).not.toHaveProperty('apiKey'); expect(sendInput).not.toHaveProperty('provider'); expect(sendInput).not.toHaveProperty('baseUrl');
  expect(fake.call).toHaveBeenCalledWith('ai.chat.step', { conversationId: 'chat-1', turnId: turn.id, step: 0 });
  expect(w.text()).toContain('个人接口回答');
});
it('restoring a saved-provider turn leaves the next personal selection intact and resumes without temporary credentials', async () => {
  const prior = { ...turn, service: 'byok' as const, provider: 'anthropic', model: 'old-model', providerProfile: { id: 'old-profile', version: 1 }, quotaHeld: false };
  const fake = fakeTransport(action => action === 'ai.providers.list' ? structuredClone(savedState) : action === 'ai.chat.latest' ? { conversation: conversation([prior]) } : action === 'ai.chat.step' ? { ...prior, state: 'complete', step: 2, result: '旧轮完成' } : undefined);
  const w = open(fake); await flushPromises();
  expect(w.text()).toContain('已选个人模型：personal-model');
  expect(w.text()).not.toContain('重新填写 Key');
  await w.findAll('button').find(button => button.text() === '继续回答')!.trigger('click'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.chat.step', { conversationId: 'chat-1', turnId: turn.id, step: 0 });
  expect(w.text()).toContain('已选个人模型：personal-model');
});
it('changing the personal selection while creation is pending affects only a later send', async () => {
  let finish!: (value: AiConversation) => void;
  const pending = new Promise<AiConversation>(resolve => { finish = resolve; });
  const fake = fakeTransport((action, input) => {
    if (action === 'ai.providers.list') return structuredClone(savedState);
    if (action === 'ai.providers.select') return { ...structuredClone(savedState), version: 5, selection: { profile: { id: 'personal-1', version: 2 }, model: input.model } };
    if (action === 'ai.chat.create') return pending;
    if (action === 'ai.chat.send') return { ...turn, state: 'complete', service: 'byok', provider: 'openai-chat', model: input.model, providerProfile: input.providerProfile, quotaHeld: false, result: '个人结果' };
  });
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('第一个问题'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  await w.get('#provider-model-personal-1').setValue('second-model'); await w.get('[data-test="select-provider"]').trigger('click'); await flushPromises();
  finish(conversation()); await flushPromises();
  const first = vi.mocked(fake.call).mock.calls.find(([action]) => action === 'ai.chat.send')![1]; expect(first).toMatchObject({ model: 'personal-model', providerProfile: { id: 'personal-1', version: 2 } });
  await w.get('#assistant-question').setValue('第二个问题'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  const sends = vi.mocked(fake.call).mock.calls.filter(([action]) => action === 'ai.chat.send'); expect(sends[1]![1]).toMatchObject({ model: 'second-model' });
});
it('changing the personal selection does not replace an in-flight temporary connection between batches', async () => {
  let finish!: (value: AiChatTurn) => void;
  const pending = new Promise<AiChatTurn>(resolve => { finish = resolve; });
  const temporary = { ...turn, service: 'byok' as const, model: 'temporary-model', quotaHeld: false };
  const fake = fakeTransport((action, input) => {
    if (action === 'ai.providers.list') return structuredClone(savedState);
    if (action === 'ai.providers.select') return { ...structuredClone(savedState), version: 5 };
    if (action === 'ai.chat.send') return temporary;
    if (action === 'ai.chat.step') return input.step === 0 ? pending : { ...temporary, state: 'complete', step: 2, result: '临时接口完成' };
  });
  const w = open(fake); await flushPromises(); await w.get('[data-test="use-temporary-api"]').trigger('click'); await w.get('#assistant-model').setValue('temporary-model'); await w.get('#assistant-key').setValue('only-in-memory');
  await w.get('#assistant-question').setValue('本次问题'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  await w.get('[data-test="select-provider"]').trigger('click'); await flushPromises(); expect((w.get('#assistant-key').element as HTMLInputElement).value).toBe('');
  finish({ ...temporary, step: 1 }); await flushPromises();
  const steps = vi.mocked(fake.call).mock.calls.filter(([action]) => action === 'ai.chat.step'); expect(steps).toHaveLength(2);
  expect(steps[1]![1]).toMatchObject({ connection: { provider: 'deepseek', model: 'temporary-model', apiKey: 'only-in-memory' } });
});
it('changes the idempotency key after choosing a different saved profile version', async () => {
  let selectedVersion = 2;
  const fake = fakeTransport((action, input) => {
    if (action === 'ai.providers.list') return structuredClone(savedState);
    if (action === 'ai.providers.select') { selectedVersion++; return { ...structuredClone(savedState), version: 5, profiles: [{ ...savedState.profiles[0]!, version: selectedVersion }], selection: { profile: { id: 'personal-1', version: selectedVersion }, model: input.model } }; }
    if (action === 'ai.chat.send') throw new Error('lost response');
  });
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('同一问题'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  await w.get('[data-test="select-provider"]').trigger('click'); await flushPromises(); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  const sends = vi.mocked(fake.call).mock.calls.filter(([action]) => action === 'ai.chat.send'); expect((sends[0]![1] as any).requestId).not.toBe((sends[1]![1] as any).requestId);
});
it('account changes discard unsaved provider keys and old configuration responses', async () => {
  let sessionListener!: (session: AuthSession | null) => void, finish!: (value: AiProviderState) => void, reads = 0;
  const pending = new Promise<AiProviderState>(resolve => { finish = resolve; });
  const fake = fakeTransport(action => action === 'ai.providers.list' ? ++reads === 1 ? { ...structuredClone(savedState), selection: null } : reads === 2 ? pending : { storageConfigured: true, version: 0, profiles: [], selection: null } : undefined);
  fake.onSessionChange = vi.fn(listener => { sessionListener = listener; return vi.fn(); });
  const w = open(fake); await flushPromises(); await w.get('[data-test="add-provider"]').trigger('click'); await w.get('#provider-api-key').setValue('old-account-secret');
  sessionListener({ uid: 'new-account', username: null }); await flushPromises(); expect(w.find('#provider-api-key').exists()).toBe(false);
  sessionListener({ uid: 'third-account', username: null }); await flushPromises();
  finish({ ...structuredClone(savedState), profiles: [{ ...savedState.profiles[0]!, name: '旧账号配置' }] }); await flushPromises();
  expect(w.text()).not.toContain('旧账号配置'); expect(w.html()).not.toContain('old-account-secret');
});
