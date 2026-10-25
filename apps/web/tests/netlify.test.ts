import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('@netlify/identity', () => ({ confirmEmail:vi.fn(async()=>({id:'verified'})),hydrateSession: vi.fn(async () => null), onAuthChange: vi.fn(() => () => {}) }));
const fetcher = vi.fn();
beforeEach(() => { vi.resetModules(); vi.stubGlobal('fetch', fetcher); fetcher.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });
it('Netlify login and business calls use same-origin cookies and never CloudBase', async () => {
  fetcher.mockResolvedValue({ json: async () => ({ ok: true, data: { uid: 'owner', username: 'owner@example.test' } }) });
  const { netlifyTransport } = await import('../src/lib/netlify');
  await netlifyTransport.signIn(' owner@example.test ', 'fixture-password');
  expect(fetcher).toHaveBeenCalledWith('/.netlify/functions/auth?op=login', expect.objectContaining({ credentials: 'same-origin', body: JSON.stringify({ email: 'owner@example.test', password: 'fixture-password' }) }));
  await netlifyTransport.call('ai.step', { taskId: 'task', step: 0 });
  expect(fetcher).toHaveBeenLastCalledWith('/.netlify/functions/api', expect.objectContaining({ body: JSON.stringify({ action: 'ai.step', input: { taskId: 'task', step: 0 } }) }));
});
it('platform HTML failures are sanitized and never retried', async () => {
  fetcher.mockResolvedValue({ json: async () => { throw new Error('private upstream body'); } });
  const { netlifyTransport } = await import('../src/lib/netlify');
  await expect(netlifyTransport.call('ai.status', {})).rejects.toMatchObject({ code: 'CONNECTION_FAILED' }); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('expired sessions clear subscribers before an application error is returned', async () => {
  fetcher.mockResolvedValue({ json: async () => ({ ok: false, code: 'UNAUTHENTICATED', message: '请登录' }) });
  const { netlifyTransport } = await import('../src/lib/netlify'), changed = vi.fn(), stop = netlifyTransport.onSessionChange(changed);
  await expect(netlifyTransport.call('session.get', {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(changed).toHaveBeenCalledWith(null); stop();
});
it('signup uses the same-origin auth endpoint and confirmation validates a server session',async()=>{
  const {netlifyTransport}=await import('../src/lib/netlify');
  fetcher.mockResolvedValueOnce({json:async()=>({ok:true,data:{verificationRequired:true}})});
  await netlifyTransport.signUp!(' new@example.test ','synthetic-password');
  expect(fetcher).toHaveBeenLastCalledWith('/.netlify/functions/auth?op=signup',expect.objectContaining({credentials:'same-origin',redirect:'error',body:JSON.stringify({email:'new@example.test',password:'synthetic-password'})}));
  fetcher.mockResolvedValueOnce({json:async()=>({ok:true,data:{uid:'verified',username:'new@example.test'}})});
  const value=await netlifyTransport.confirmEmail!('synthetic-token');expect(value.uid).toBe('verified');expect(fetcher).toHaveBeenLastCalledWith('/.netlify/functions/auth',expect.objectContaining({method:'GET',credentials:'same-origin'}));
});
