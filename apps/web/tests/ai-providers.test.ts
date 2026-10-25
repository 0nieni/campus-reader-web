import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { AiProviderState, AiSavedProvider } from '@campus/contracts';
import AiProviderSettings from '../src/components/AiProviderSettings.vue';
import type { Transport } from '../src/lib/transport';
import { ClientError } from '../src/lib/errors';

const profile: AiSavedProvider = { id: 'profile-1', name: '阅读服务', protocol: 'openai-chat', baseUrl: 'https://example.com/v1', models: ['model-a', 'model-b'], defaultModel: 'model-a', version: 2, keySaved: true, updatedAt: '2026-10-24T00:00:00.000Z' };
const initial: AiProviderState = { storageConfigured: true, version: 3, profiles: [profile], selection: null };
function fakeTransport(start = initial, override?: (action: string, input: any) => unknown): Transport {
  let state = structuredClone(start);
  return { restore: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), onSessionChange: vi.fn(), call: vi.fn(async (action, input: any) => {
    const result = override?.(action, input); if (result !== undefined) return result;
    if (action === 'ai.providers.list') return structuredClone(state);
    if (action === 'ai.providers.save') {
      const { apiKey: _key, version: _stateVersion, profileVersion: _profileVersion, ...metadata } = input.profile;
      const id = input.profile.id || 'profile-new';
      const previous = state.profiles.find(item => item.id === id);
      const saved = { ...metadata, id, version: (previous?.version || 0) + 1, keySaved: true, updatedAt: new Date().toISOString() };
      state.profiles = [...state.profiles.filter(item => item.id !== id), saved];
      if (state.selection && state.selection.profile.id === id) state.selection.profile.version = saved.version;
    } else if (action === 'ai.providers.select') state.selection = input.id ? { profile: { id: input.id, version: state.profiles.find(item => item.id === input.id)!.version }, model: input.model } : null;
    else if (action === 'ai.providers.remove') { state.profiles = state.profiles.filter(item => item.id !== input.id); if (state.selection?.profile.id === input.id) state.selection = null; }
    else throw new Error(`Unexpected ${action}`);
    state.version++;
    return structuredClone(state);
  }) as Transport['call'] };
}
const mounted: ReturnType<typeof mount>[] = [];
function open(fake: Transport) { const wrapper = mount(AiProviderSettings, { props: { transport: fake } }); mounted.push(wrapper); return wrapper; }
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks(); });

it('lists account metadata and model choices without requesting a model or exposing a password', async () => {
  const fake = fakeTransport(); const w = open(fake); await flushPromises();
  expect(w.text()).toContain('阅读服务'); expect(w.text()).toContain('Key 已保存'); expect(w.get('#provider-model-profile-1').findAll('option').map(option => option.text())).toEqual(['model-a', 'model-b']);
  expect(vi.mocked(fake.call).mock.calls.map(([action]) => action)).toEqual(['ai.providers.list']); expect(w.find('input[type="password"]').exists()).toBe(false);
});
it('saves a new provider separately from selecting it and clears the key after saving', async () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const fake = fakeTransport(); const w = open(fake); await flushPromises(); await w.get('[data-test="add-provider"]').trigger('click');
  expect((w.get('#provider-models').element as HTMLTextAreaElement).value).toBe('');
  await w.get('#provider-template').setValue('custom'); await w.get('#provider-name').setValue('个人接口'); await w.get('#provider-base-url').setValue('https://example.org/v1'); await w.get('#provider-models').setValue('alpha\nbeta, alpha，gamma'); await w.get('#provider-default-model').setValue('beta'); await w.get('#provider-api-key').setValue('synthetic-secret');
  await w.get('form').trigger('submit'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.providers.save', { profile: { version: 3, name: '个人接口', protocol: 'openai-chat', baseUrl: 'https://example.org/v1', models: ['alpha', 'beta', 'gamma'], defaultModel: 'beta', apiKey: 'synthetic-secret' } });
  expect(vi.mocked(fake.call).mock.calls.some(([action]) => action === 'ai.providers.select')).toBe(false);
  expect(w.find('#provider-api-key').exists()).toBe(false); expect(w.html()).not.toContain('synthetic-secret'); expect(setItem).not.toHaveBeenCalled();
  await w.get('[data-test="add-provider"]').trigger('click'); expect((w.get('#provider-api-key').element as HTMLInputElement).value).toBe('');
});
it('selects the explicitly chosen model using the current account state version', async () => {
  const fake = fakeTransport(); const w = open(fake); await flushPromises(); await w.get('#provider-model-profile-1').setValue('model-b'); await w.get('[data-test="select-provider"]').trigger('click'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.providers.select', { id: 'profile-1', model: 'model-b', version: 3 });
  expect(w.emitted('selected')?.at(-1)).toEqual([{ profile: { id: 'profile-1', version: 2 }, model: 'model-b' }, true]);
});
it('edits metadata with a blank key to keep the saved key and includes both versions', async () => {
  const fake = fakeTransport(); const w = open(fake); await flushPromises(); await w.get('[data-test="edit-provider"]').trigger('click');
  expect(w.get('#provider-api-key').attributes('type')).toBe('password'); expect(w.get('#provider-api-key').attributes('placeholder')).toContain('留空保留');
  await w.get('#provider-name').setValue('改后的名称'); await w.get('form').trigger('submit'); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('ai.providers.save', { profile: { version: 3, id: 'profile-1', profileVersion: 2, name: '改后的名称', protocol: 'openai-chat', baseUrl: profile.baseUrl, models: profile.models, defaultModel: profile.defaultModel } });
});
it.each(['address', 'protocol'])('requires a new key after changing the %s', async field => {
  const fake = fakeTransport(); const w = open(fake); await flushPromises(); await w.get('[data-test="edit-provider"]').trigger('click');
  if (field === 'address') await w.get('#provider-base-url').setValue('https://other.example.com/v1'); else await w.get('#provider-protocol').setValue('anthropic');
  expect(w.text()).toContain('必须重新填写 Key'); await w.get('form').trigger('submit'); await flushPromises(); expect(w.text()).toContain('请重新填写对应的 API Key');
  expect(vi.mocked(fake.call).mock.calls.some(([action]) => action === 'ai.providers.save')).toBe(false);
});
it('refreshes conflicting configuration and discards the stale draft key without silently saving', async () => {
  let reads = 0;
  const fake = fakeTransport(initial, action => {
    if (action === 'ai.providers.list') return { ...structuredClone(initial), version: ++reads === 1 ? 3 : 9, profiles: [{ ...profile, name: reads === 1 ? profile.name : '另一页面的配置', version: reads === 1 ? 2 : 4 }] };
    if (action === 'ai.providers.save') throw new ClientError('AI_PROVIDER_CONFLICT', '配置冲突');
  });
  const w = open(fake); await flushPromises(); await w.get('[data-test="edit-provider"]').trigger('click'); await w.get('#provider-api-key').setValue('discarded-key'); await w.get('form').trigger('submit'); await flushPromises();
  expect(w.text()).toContain('另一页面的配置'); expect(w.text()).toContain('已加载最新版本'); expect(w.find('form').exists()).toBe(false);
  await w.get('[data-test="edit-provider"]').trigger('click'); expect((w.get('#provider-api-key').element as HTMLInputElement).value).toBe('');
  expect(vi.mocked(fake.call).mock.calls.filter(([action]) => action === 'ai.providers.save')).toHaveLength(1);
});
it('deletes the current provider only on confirmation and clears the personal selection', async () => {
  const fake = fakeTransport({ ...initial, selection: { profile: { id: profile.id, version: profile.version }, model: 'model-a' } }); const w = open(fake); await flushPromises();
  await w.get('[data-test="delete-provider"]').trigger('click'); expect(vi.mocked(fake.call).mock.calls.some(([action]) => action === 'ai.providers.remove')).toBe(false);
  await w.get('[data-test="confirm-delete-provider"]').trigger('click'); await flushPromises(); expect(fake.call).toHaveBeenCalledWith('ai.providers.remove', { id: profile.id, version: 3 });
  expect(w.emitted('selected')?.at(-1)).toEqual([null, false]); expect(w.text()).toContain('请明确选择');
});
it('shows unavailable encrypted storage and prevents editing while temporary and official service remain parent choices', async () => {
  const fake = fakeTransport({ storageConfigured: false, version: 0, profiles: [], selection: null }); const w = open(fake); await flushPromises();
  expect(w.text()).toContain('个人配置保存待启用'); expect(w.text()).toContain('官方 AI 和临时 API 仍可使用'); expect(w.get('[data-test="add-provider"]').attributes('disabled')).toBeDefined(); expect(w.find('form').exists()).toBe(false);
});
it('rejects more than twenty models without making a save request', async () => {
  const fake = fakeTransport(); const w = open(fake); await flushPromises(); await w.get('[data-test="add-provider"]').trigger('click'); await w.get('#provider-models').setValue(Array.from({ length: 21 }, (_, index) => `model-${index}`).join('\n')); await w.get('#provider-default-model').setValue('model-0'); await w.get('#provider-api-key').setValue('synthetic-secret'); await w.get('form').trigger('submit'); await flushPromises();
  expect(w.text()).toContain('1 至 20 个模型'); expect(vi.mocked(fake.call).mock.calls.some(([action]) => action === 'ai.providers.save')).toBe(false);
});
it('ignores a late load after unmounting and never emits an old selection', async () => {
  let finish!: (value: AiProviderState) => void; const pending = new Promise<AiProviderState>(resolve => { finish = resolve; });
  const fake = fakeTransport(initial, action => action === 'ai.providers.list' ? pending : undefined); const w = open(fake); await flushPromises(); w.unmount(); finish({ ...initial, selection: { profile: { id: profile.id, version: profile.version }, model: 'model-a' } }); await flushPromises(); expect(w.emitted('selected')).toBeUndefined();
});
