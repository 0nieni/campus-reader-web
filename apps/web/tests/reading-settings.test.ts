import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AccountSettingsDialog from '../src/components/AccountSettingsDialog.vue';
import AssistantPanel from '../src/components/AssistantPanel.vue';
import type { Transport } from '../src/lib/transport';

const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => { mounted.splice(0).forEach(w => w.unmount()); vi.restoreAllMocks(); });
function fake(): Transport {
  return { onSessionChange: vi.fn(() => () => {}), call: vi.fn(async (action: string, input: any) => {
    if (action === 'ai.profile.get') return { schoolId: input.schoolId, interests: ['竞赛'], goals: '准备比赛', learningEnabled: false, version: 2 };
    if (action === 'ai.memory.get') return { schoolId: input.schoolId, enabled: true, version: 3, generation: 1, items: [] };
    if (action === 'ai.profile.save') return { ...input, version: 3 };
    if (action === 'ai.memory.configure') return { schoolId: input.schoolId, enabled: input.enabled, version: 4, generation: 2, items: [] };
    if (action === 'ai.providers.list') return { storageConfigured: false, version: 0, profiles: [], selection: null };
    if (action === 'ai.recommend') return { items: [], search: { state: 'idle', message: '' }, coverage: '' };
    if (action === 'ai.chat.latest') return { conversation: null };
    if (action === 'ai.status') return { officialConfigured: true, quota: { remaining: 3, limit: 3, used: 0, held: 0 }, providers: [] };
    throw new Error('Unexpected ' + action);
  }) } as unknown as Transport;
}
it('personal workspace contains both reading preferences and automatic memory controls and saves through their existing APIs', async () => {
  const t = fake(), w = mount(AccountSettingsDialog, { props: { transport: t, username: 'member@example.test', schoolId: 'bjtu' } as any }); mounted.push(w);
  const button = w.findAll('.account-tabs button').find(b => b.text() === '阅读偏好');
  expect(button, 'personal workspace must offer reading settings').toBeDefined();
  await button!.trigger('click'); await flushPromises();
  expect(w.text()).toContain('AI记住的信息');
  await w.get('#assistant-interests').setValue('编程，竞赛');
  await w.get('[data-test="save-preferences"]').trigger('click'); await flushPromises();
  expect(t.call).toHaveBeenCalledWith('ai.profile.save', expect.objectContaining({ schoolId: 'bjtu', version: 2, interests: ['编程', '竞赛'] }));
  await w.get('[data-test="memory-enabled"]').setValue(false); await flushPromises();
  expect(t.call).toHaveBeenCalledWith('ai.memory.configure', { schoolId: 'bjtu', enabled: false, version: 3 });
  expect(w.emitted('readingChanged')).toHaveLength(2);
});
it('logged-out workspace reading settings request sign-in before loading account-owned data', async () => {
  const t = fake(), w = mount(AccountSettingsDialog, { props: { transport: t, username: null, anonymous: true, schoolId: 'bjtu' } as any }); mounted.push(w);
  const button = w.findAll('.account-tabs button').find(b => b.text() === '阅读偏好');
  expect(button).toBeDefined(); await button!.trigger('click'); await flushPromises();
  expect(w.text()).toContain('登录以设置 AI');
  expect(t.call).not.toHaveBeenCalled();
});
it('AI reading rail keeps source discovery but moves editable preference and memory controls out', async () => {
  const w = mount(AssistantPanel, { props: { transport: fake(), schoolId: 'bjtu', selection: [] } }); mounted.push(w); await flushPromises();
  expect(w.find('#assistant-search').exists()).toBe(true);
  expect(w.find('#assistant-interests').exists()).toBe(false);
  expect(w.find('[data-test="memory-section"]').exists()).toBe(false);
});
