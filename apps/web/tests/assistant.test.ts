import { afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import AssistantPanel from '../src/components/AssistantPanel.vue';
import AiReadingSettings from '../src/components/AiReadingSettings.vue';
import { defineComponent,h,ref } from 'vue';
import type { ReadingSettingsChange } from '../src/lib/transport';
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
function open(fake: Transport, selection: Notice[] = []) { const w = mount(AssistantPanel, { props: { transport: fake, schoolId: 'bjtu', selection } }); mounted.push(w); return w; }
it('unlimited official daily usage allows another question and does not show an exhausted daily allowance', async () => {
  const fake = fakeTransport(a => a === 'ai.status' ? { quota: { limit: null, remaining: null, used: 7, held: 2 }, officialConfigured: true, officialModel: 'chat', providers: [] } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('继续提问');
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeUndefined();
  expect(w.text()).toContain('不限每日提问次数');
  expect(w.text()).not.toContain('每天最多 3 次'); expect(w.text()).not.toContain('今日官方额度已用完');
});
function openWithSettings(fake:Transport) {
 const Harness=defineComponent({props:['transport','schoolId','selection'],setup(props){
  const change=ref<ReadingSettingsChange|null>(null),snapshot=ref<AiMemoryState|null>(null);
  return()=>h('div',[
   h(AssistantPanel,{transport:props.transport,schoolId:props.schoolId,selection:props.selection||[],readingChange:change.value,onMemoryLoaded:(value:AiMemoryState)=>{snapshot.value=value;}}),
   h(AiReadingSettings,{transport:props.transport,schoolId:props.schoolId,memorySnapshot:snapshot.value,onChanged:(value:ReadingSettingsChange)=>{change.value=value;}}),
  ]);
 }});
 const w=mount(Harness,{props:{transport:fake,schoolId:'bjtu',selection:[]}});mounted.push(w);return w;
}
it('saving workspace preferences during a model request cannot replace its completed answer with a stale conversation', async () => {
  let complete!: (value: AiChatTurn) => void, latest!: (value: AiConversation) => void, reads = 0;
  const step = new Promise<AiChatTurn>(resolve => { complete = resolve; });
  const stale = new Promise<AiConversation>(resolve => { latest = resolve; });
  const fake = fakeTransport(a => a === 'ai.chat.step' ? step : a === 'ai.chat.latest' ? reads++ === 0 ? { conversation: null } : stale.then(conversation => ({ conversation })) : undefined);
  const w = openWithSettings(fake); await flushPromises();
  await w.get('#assistant-question').setValue('需要什么材料？'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  await w.get('[data-test="save-preferences"]').trigger('click'); await flushPromises();
  complete({ ...turn, state: 'complete', result: '已经完成的回答。', quotaHeld: false }); await flushPromises();
  latest(conversation([{ ...turn, state: 'running' }])); await flushPromises();
  expect(w.get('.markdown-content').text()).toBe('已经完成的回答。');
  expect(w.text()).not.toContain('正在回答');
});
it('the latest workspace preference refresh wins over an older delayed recommendation response', async () => {
  let finish!: (value: unknown) => void, calls = 0;
  const delayed = new Promise(resolve => { finish = resolve; });
  const result = (reason: string) => ({ items: [{ ...notice, reason, originalUrl: null, readState: 'title_only', checkedAt: null, allowAi: true }], search: { state: 'idle', message: '' }, coverage: '' });
  const fake = fakeTransport(a => a === 'ai.recommend' ? ++calls === 2 ? delayed : result(calls > 2 ? '最新偏好推荐' : '初始推荐') : undefined);
  const w = openWithSettings(fake); await flushPromises();
  await w.get('[data-test="save-preferences"]').trigger('click'); await flushPromises();
  await w.get('[data-test="save-preferences"]').trigger('click'); await flushPromises();
  finish(result('较早的迟到推荐')); await flushPromises();
  expect(w.text()).toContain('最新偏好推荐'); expect(w.text()).not.toContain('较早的迟到推荐');
});
afterEach(() => { mounted.splice(0).forEach(w => w.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); });
it('an unselected question advances automatic web steps and renders verified sources with step progress', async () => {
  let step = 0;
  const refs = [{ reference: 'R1', itemId: 'web-doc', title: 'TypeScript 官方文档', originalUrl: 'https://www.typescriptlang.org/docs/' }];
  const fake = fakeTransport(a => a === 'ai.status' ? { quota: { limit: 3, used: 0, held: 0, remaining: 3 }, officialConfigured: true, officialModel: 'chat', searchConfigured: true, providers: [] }
    : a === 'ai.chat.send' ? { ...turn, references: [], totalSteps: 1, search: { state: 'idle', message: '模型尚未请求联网搜索。' } }
    : a === 'ai.chat.step' ? { ...turn, references: step < 2 ? [] : refs, step: ++step, totalSteps: step + (step === 4 ? 0 : 1), state: step === 4 ? 'complete' : 'ready', result: step === 4 ? '阅读文档可了解类型。[R1]' : null, quotaHeld: step !== 4, message: '正在核验正文', search: { state: 'complete', message: '本次公开搜索已完成', candidateCount: 3, readableCount: step >= 3 ? 1 : 0 } } : undefined);
  const w = open(fake); await flushPromises();
  expect(w.text()).toContain('每轮提问会先联网搜索');
  await w.get('#assistant-question').setValue('介绍最新 TypeScript');
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(step).toBe(4);
  expect(w.get('.turn-search-counts').text()).toContain('可读正文 1 篇');
  expect(w.get('.answer-references a').attributes('href')).toBe('https://www.typescriptlang.org/docs/');
  expect(w.get('.turn-meta').text()).toContain('4/4 步');
  expect(vi.mocked(fake.call).mock.calls.some(([a, i]) => a === 'ai.recommend' && (i as any).search)).toBe(false);
});

it('a direct non-search answer does not show an idle search status as a performed search', async () => {
  const direct = { ...turn, references: [], state: 'complete' as const, result: '你好。', quotaHeld: false, search: { state: 'idle' as const, message: '模型尚未请求联网搜索。' } };
  const w = open(fakeTransport(a => a === 'ai.chat.latest' ? { conversation: conversation([direct]) } : undefined));
  await flushPromises(); expect(w.find('.turn-search-status').exists()).toBe(false);
  expect(w.get('.markdown-content').text()).toBe('你好。');
});
it.each([
  { officialConfigured: false, remaining: 3, question: '你能联网吗' },
  { officialConfigured: true, remaining: 0, question: '你可以联网搜索吗' },
  { officialConfigured: false, remaining: 0, question: '这里支持联网搜索吗' },
])('answers search capability with officialConfigured=$officialConfigured and remaining=$remaining without model credentials', async ({ officialConfigured, remaining, question }) => {
  const fake = fakeTransport(a => a === 'ai.status' ? { quota: { limit: 3, remaining, used: 3 - remaining, held: 0 }, officialConfigured, officialModel: '', searchConfigured: false, providers: [] }
    : a === 'ai.chat.send' ? { ...turn, question, taskId: null, state: 'complete', references: [], result: '联网搜索尚未配置，请联系网站管理员。', quotaHeld: false, totalSteps: 0 } : undefined);
  const w = open(fake, [notice]); await flushPromises(); await w.get('#assistant-question').setValue(question);
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeUndefined();
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('.markdown-content').text()).toContain('联网搜索尚未配置');
  expect(fake.call).toHaveBeenCalledWith('ai.chat.send', expect.objectContaining({ question, service: 'official' }));
  const input = vi.mocked(fake.call).mock.calls.find(([a]) => a === 'ai.chat.send')![1];
  expect(input).not.toHaveProperty('itemIds'); expect(input).not.toHaveProperty('provider'); expect(input).not.toHaveProperty('model');
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.step')).toBe(false);
});
it('uses the program capability path with BYOK selected, omitting BYOK settings and selected articles', async () => {
  const fake = fakeTransport(a => a === 'ai.chat.send' ? { ...turn, taskId: null, state: 'complete', references: [], result: '搜索服务已配置，是否可用需实际搜索确认。', quotaHeld: false, totalSteps: 0 } : undefined);
  const w = open(fake, [notice]); await flushPromises(); await w.get('input[value="byok"]').setValue();
  await w.get('#assistant-model').setValue('private-model');
  await w.get('#assistant-question').setValue('能不能帮我查一下本校比赛');
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeDefined();
  await w.get('#assistant-question').setValue('你能联网吗');
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeUndefined();
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('.markdown-content').text()).toContain('是否可用需实际搜索确认');
  const input = vi.mocked(fake.call).mock.calls.find(([a]) => a === 'ai.chat.send')![1];
  expect(input).toMatchObject({ question: '你能联网吗', service: 'official' });
  for (const field of ['itemIds', 'provider', 'model', 'connection', 'apiKey']) expect(input).not.toHaveProperty(field);
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.step')).toBe(false);
});
it.each(['查一下', '帮我看看学校有没有新的讲座', '最近我们学校有什么比赛可以报名', '联网搜索是什么意思', '你能联网吗？顺便查一下本校比赛'])('keeps the actual search or ordinary question %s blocked without model quota', async question => {
  const fake = fakeTransport(a => a === 'ai.status' ? { quota: { limit: 3, remaining: 0, used: 3, held: 0 }, officialConfigured: true, officialModel: 'chat', providers: [] } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue(question);
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeDefined();
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.send')).toBe(false);
});
it.each([true, false, undefined])('shows only the known search configuration for searchConfigured=%s and allows an explicit search', async searchConfigured => {
  const fake = fakeTransport(a => a === 'ai.status' ? { quota: { limit: 3, remaining: 0, used: 3, held: 0 }, officialConfigured: false, officialModel: '', searchConfigured, providers: [] } : undefined);
  const w = open(fake); await flushPromises();
  expect(w.get('[data-test="search"]').text()).toBe('联网找资料');
  if (searchConfigured === undefined) expect(w.find('.search-configuration').exists()).toBe(false);
  else {
    const configuration = w.get('.search-configuration').text();
    expect(configuration).toContain(searchConfigured ? '已配置' : '尚未配置');
    if (searchConfigured) { expect(configuration).toContain('实际结果'); expect(configuration).toContain('不要联网'); expect(configuration).not.toContain('搜索成功'); }
    else expect(configuration).toContain('管理员');
  }
  await w.get('#assistant-search').setValue('讲座'); await w.get('form.source-search').trigger('submit'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.recommend', { schoolId: 'bjtu', query: '讲座', search: true });
});
it('preserves the server search result and distinguishes completed search from unreadable article bodies', async () => {
  const fake = fakeTransport((a, input) => a === 'ai.recommend' && input.search ? { items: [{ ...notice, originalUrl: 'https://example.edu/notice', reason: '搜索候选', readState: 'snippet_only', checkedAt: null, allowAi: false }], search: { state: 'complete', message: '已找到候选公告，正文暂不可读取。' }, coverage: '本次联网搜索结果' } : undefined);
  const w = open(fake); await flushPromises(); await w.get('form.source-search').trigger('submit'); await flushPromises();
  expect(w.get('.search-status').text()).toBe('已找到候选公告，正文暂不可读取。');
  expect(w.get('.source-meta').text()).toContain('仅摘要');
  expect(w.get('[data-test="select-source"]').attributes('disabled')).toBeDefined();
  expect(w.get('.recommendation h3 a').attributes('href')).toBe('https://example.edu/notice');
});
it.each([
  { candidateCount: 2, readableCount: 0 },
  { candidateCount: 0, readableCount: 0 },
  { candidateCount: undefined, readableCount: undefined },
  { candidateCount: 2, readableCount: undefined },
  { candidateCount: undefined, readableCount: 0 },
])('puts real search status and supplied counts $candidateCount/$readableCount before the answer', async counts => {
  const completed: AiChatTurn = { ...turn, state: 'complete', taskId: null, programReply: 'search_status', quotaHeld: false, result: '没有取得可用于回答的正文，请打开原文核对。', search: { state: 'complete', message: '本次搜索已完成，尚无可用于回答的正文。', ...counts } };
  const w = open(fakeTransport(a => a === 'ai.chat.latest' ? { conversation: conversation([completed]) } : undefined)); await flushPromises();
  const statusElement = w.get('.turn-search-status').element, answer = w.get('.markdown-content').element;
  expect(statusElement.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(w.get('.turn-search-status').text()).toContain(completed.search!.message);
  if (counts.candidateCount === undefined && counts.readableCount === undefined) expect(w.find('.turn-search-counts').exists()).toBe(false);
  else {
    const text = w.get('.turn-search-counts').text();
    if (counts.candidateCount === undefined) expect(text).not.toContain('搜索候选');
    else expect(text).toContain(`搜索候选 ${counts.candidateCount} 条`);
    if (counts.readableCount === undefined) expect(text).not.toContain('可读正文');
    else expect(text).toContain(`可读正文 ${counts.readableCount} 篇`);
  }
});
it.each(['search_capability', 'search_status'] as const)('does not reload memory or recommendations after a direct %s program reply', async programReply => {
  const fake = fakeTransport(a => a === 'ai.chat.send' ? { ...turn, taskId: null, state: 'complete', result: '搜索服务已配置，可用性需实际检索确认。', quotaHeld: false, programReply, totalSteps: 0 } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue(programReply === 'search_capability' ? '你能联网吗' : '查一下');
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('.markdown-content').text()).toContain('可用性需实际检索确认');
  for (const action of ['ai.memory.get', 'ai.recommend']) expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === action)).toHaveLength(1);
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.step')).toBe(false);
});
it.each(['search_capability', 'search_status'] as const)('labels the %s program result without implying a model answered', async programReply => {
  const fake = fakeTransport(a => a === 'ai.chat.latest' ? { conversation: conversation([{ ...turn, taskId: null, state: 'complete', quotaHeld: false, result: '请以实际搜索结果为准。', programReply }]) } : undefined);
  const w = open(fake); await flushPromises();
  expect(w.get('.turn-meta').text()).toBe('系统说明 · 未调用模型');
});
it.each(['search_capability', 'search_status'] as const)('recovers a lost %s program reply without unrelated reloads or a second send', async programReply => {
  let requestId = '';
  const fake = fakeTransport((a, input) => {
    if (a === 'ai.chat.send') { requestId = input.requestId; throw new Error('response lost'); }
    if (a === 'ai.chat.get') return conversation([{ ...turn, id: requestId, taskId: null, state: 'complete', result: '本次搜索尚未完成，请稍后重试。', quotaHeld: false, programReply, totalSteps: 0 }]);
  });
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue(programReply === 'search_capability' ? '你能联网吗' : '查一下');
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('.markdown-content').text()).toContain('本次搜索尚未完成');
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.chat.send')).toHaveLength(1);
  for (const action of ['ai.memory.get', 'ai.recommend']) expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === action)).toHaveLength(1);
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.step')).toBe(false);
});
it('keeps refreshing legacy completed memory commands without a program marker', async () => {
  const fake = fakeTransport(a => a === 'ai.chat.send' ? { ...turn, taskId: null, state: 'complete', result: '已忘记专业。', quotaHeld: false, totalSteps: 0 } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('忘掉我的专业');
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(w.get('.markdown-content').text()).toContain('已忘记专业');
  for (const action of ['ai.memory.get', 'ai.recommend']) expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === action)).toHaveLength(2);
});
it.each(['search_capability', 'search_status'] as const)('refreshes chat status without reloading unrelated data for a completed %s reply', async programReply => {
  const value = conversation([{ ...turn, id: 'older', state: 'uncertain' }, { ...turn, id: 'newer', state: 'complete', taskId: null, quotaHeld: false, programReply, result: '实际搜索未完成。' }]);
  const fake = fakeTransport(a => a === 'ai.chat.latest' ? { conversation: value } : a === 'ai.chat.get' ? value : undefined);
  const w = open(fake); await flushPromises();
  await w.findAll('button').find(button => button.text() === '刷新对话状态')!.trigger('click'); await flushPromises();
  expect(w.get('.markdown-content').text()).toContain('实际搜索未完成');
  expect(fake.call).toHaveBeenCalledWith('ai.chat.get', { conversationId: 'chat-1' });
  for (const action of ['ai.memory.get', 'ai.recommend']) expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === action)).toHaveLength(1);
});
it('refreshes automatic memories after an answer completes', async () => {
  let reads = 0;
  const fake = fakeTransport(a => a === 'ai.memory.get' ? memory(reads++ ? [memoryItem] : []) : undefined);
  const w = open(fake); await flushPromises(); expect(w.text()).not.toContain(memoryItem.text);
  await w.get('#assistant-question').setValue('我准备参加程序设计比赛'); await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(JSON.stringify(w.emitted('memoryLoaded')?.at(-1))).toContain(memoryItem.text);
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
  expect(JSON.stringify(w.emitted('memoryLoaded')?.at(-1))).toContain(memoryItem.text); expect(w.text()).toContain('已完成回答');
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.chat.step')).toHaveLength(1);
});
it.each(['configure', 'forget', 'clear'])('refreshes recommendations after a successful memory %s', async action => {
  let changed = false;
  const fake = fakeTransport(a => {
    if (a === 'ai.memory.get') return memory([memoryItem]);
    if (a === `ai.memory.${action}`) { changed = true; return { ...memory(action === 'configure' ? [memoryItem] : []), enabled: action !== 'configure', version: 3 }; }
    if (a === 'ai.recommend') return { items: [{ ...notice, originalUrl: null, reason: changed ? '当前手动偏好推荐' : '基于自动记忆中的旧目标推荐', readState: 'title_only', checkedAt: null, allowAi: true }], search: { state: 'idle', message: '' }, coverage: '' };
  });
  const w = openWithSettings(fake); await flushPromises(); expect(w.text()).toContain('基于自动记忆中的旧目标推荐');
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
  const w = openWithSettings(fake); await flushPromises();
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
  const w = openWithSettings(fake); await flushPromises(); await w.get('[data-test="forget-memory-goal"]').trigger('click'); await flushPromises();
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
  const w = openWithSettings(fake); await flushPromises(); await w.get('#assistant-question').setValue('你好'); expect(w.get('[data-test="send"]').attributes('disabled')).toBeDefined();
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
  const fake = fakeTransport(); const w = openWithSettings(fake); await flushPromises();
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
  const w = openWithSettings(fake); await flushPromises(); expect(w.text()).toContain('旧行为学习推荐理由');
  if (action === 'save') await w.get('[data-test="save-preferences"]').trigger('click');
  else await w.findAll('button').find(b => b.text() === '清除行为记录')!.trigger('click');
  await flushPromises(); expect(w.text()).not.toContain('旧行为学习推荐理由'); expect(w.text()).toContain('当前手动偏好推荐');
  expect(vi.mocked(fake.call).mock.calls.filter(([a]) => a === 'ai.recommend')).toHaveLength(2);
});
it('a pending refreshed recommendation cannot overwrite the next school recommendation', async () => {
  let recCalls = 0, finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const fake = fakeTransport((a, input) => {
    if (a === 'ai.recommend') { recCalls++; if (recCalls === 2) return pending; if (input.schoolId === 'other') return { items: [{ ...notice, title: '新学校推荐', originalUrl: null, reason: '本校资料', readState: 'title_only', checkedAt: null, allowAi: true }], search: { state: 'idle', message: '' }, coverage: '新学校' }; }
  });
  const w = openWithSettings(fake); await flushPromises(); await w.get('[data-test="save-preferences"]').trigger('click'); await flushPromises();
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
it.each(['no_storage', 'no_selection'] as const)('keeps ordinary saved-provider questions guarded for %s while capability needs no credentials', async scenario => {
  const fake = fakeTransport(a => a === 'ai.providers.list' ? structuredClone(savedState)
    : a === 'ai.status' ? { quota: { limit: 3, used: 3, held: 0, remaining: 0 }, officialConfigured: false, officialModel: '', providers: [] }
    : a === 'ai.chat.send' ? { ...turn, taskId: null, state: 'complete', quotaHeld: false, programReply: 'search_capability', result: '需实际检索确认。' } : undefined);
  const w = open(fake, [notice]); await flushPromises();
  const next = { ...structuredClone(savedState), storageConfigured: scenario !== 'no_storage', selection: scenario === 'no_selection' ? null : savedState.selection };
  await w.setProps({ providerChange: { state: next, activate: 'saved' } }); await flushPromises();
  await w.get('#assistant-question').setValue('需要什么材料？');
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeDefined();
  await w.get('#assistant-question').setValue('你能联网吗');
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeUndefined();
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  const input = vi.mocked(fake.call).mock.calls.find(([a]) => a === 'ai.chat.send')![1];
  expect(input).toMatchObject({ service: 'official' });
  for (const field of ['providerProfile', 'itemIds', 'provider', 'model', 'connection']) expect(input).not.toHaveProperty(field);
});
it('does not let a capability question bypass an in-flight provider configuration change', async () => {
  let finish!: (state: AiProviderState) => void;
  const pending = new Promise<AiProviderState>(resolve => { finish = resolve; });
  const fake = fakeTransport(a => a === 'ai.providers.list' ? structuredClone(savedState) : a === 'ai.providers.select' ? pending : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('你能联网吗');
  await w.get('[data-test="select-provider"]').trigger('click'); await flushPromises();
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeDefined();
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.send')).toBe(false);
  finish(structuredClone(savedState)); await flushPromises();
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeUndefined();
});
it('keeps capability questions paused for an unresolved saved-provider turn', async () => {
  const fake = fakeTransport(a => a === 'ai.providers.list' ? structuredClone(savedState) : a === 'ai.chat.latest' ? { conversation: conversation([{ ...turn, service: 'byok', providerProfile: savedState.selection!.profile, state: 'uncertain', quotaHeld: false }]) } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('你能联网吗');
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeDefined();
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  expect(vi.mocked(fake.call).mock.calls.some(([a]) => a === 'ai.chat.send')).toBe(false);
});
it('account-dialog model changes preserve conversation and quota state without starting or replaying an answer',async()=>{
 let state=structuredClone(savedState);const previous={...turn,state:'complete' as const,quotaHeld:false,result:'保留的旧回答'};
 const fake=fakeTransport(action=>action==='ai.providers.list'?structuredClone(state):action==='ai.chat.latest'?{conversation:conversation([previous])}:undefined),w=open(fake);await flushPromises();
 state={...state,version:5,selection:{profile:{id:'personal-1',version:2},model:'second-model'}};
 await w.setProps({providerChange:{state:structuredClone(state),activate:'saved'}});await flushPromises();expect(w.text()).toContain('保留的旧回答');expect(w.text()).toContain('已选个人模型：second-model');
 expect(vi.mocked(fake.call).mock.calls.filter(([a])=>a==='ai.status')).toHaveLength(1);expect(vi.mocked(fake.call).mock.calls.some(([a])=>['ai.chat.create','ai.chat.send','ai.chat.step'].includes(a))).toBe(false);
 state={...state,version:6,selection:null};await w.setProps({providerChange:{state:structuredClone(state),activate:'official'}});await flushPromises();expect((w.get('input[value="official"]').element as HTMLInputElement).checked).toBe(true);expect(w.text()).toContain('保留的旧回答');
});
it('a memory command ignores saved-provider credentials and official quota while retaining the next model selection', async () => {
  const fake = fakeTransport(action => action === 'ai.providers.list' ? structuredClone(savedState)
    : action === 'ai.status' ? { quota: { limit: 3, used: 3, held: 0, remaining: 0 }, officialConfigured: false, officialModel: '', providers: [] }
    : action === 'ai.chat.send' ? { ...turn, taskId: null, state: 'complete', result: '已忘记专业。', quotaHeld: false } : undefined);
  const w = open(fake); await flushPromises(); await w.get('#assistant-question').setValue('忘掉我的专业');
  expect(w.get('[data-test="send"]').attributes('disabled')).toBeUndefined();
  await w.get('form.assistant-composer').trigger('submit'); await flushPromises();
  const input = vi.mocked(fake.call).mock.calls.find(([action]) => action === 'ai.chat.send')![1];
  expect(input).toMatchObject({ service: 'official', question: '忘掉我的专业' });
  expect(input).not.toHaveProperty('providerProfile'); expect(input).not.toHaveProperty('model'); expect(input).not.toHaveProperty('provider');
  expect(w.text()).toContain('已选个人模型：personal-model');
  expect(vi.mocked(fake.call).mock.calls.some(([action]) => action === 'ai.chat.step')).toBe(false);
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
  expect(JSON.stringify(w.emitted('memoryLoaded')?.at(-1))).toContain(memoryItem.text);
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
  expect(JSON.stringify(w.emitted('memoryLoaded')?.at(-1))).toContain(memoryItem.text); expect(w.text()).not.toContain('已删除这条自动记忆');
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
  expect(JSON.stringify(w.emitted('memoryLoaded')?.at(-1))).toContain('新学校目标'); expect(w.text()).not.toContain('旧学校目标已删除');
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
