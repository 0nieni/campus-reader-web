import { afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import AssistantPanel from '../src/components/AssistantPanel.vue';
import type { AiChatTurn, AiConversation, Notice } from '@campus/contracts';
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
