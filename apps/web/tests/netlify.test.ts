import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('@netlify/identity', () => ({ confirmEmail:vi.fn(async()=>({id:'verified'})),recoverPassword:vi.fn(async()=>({id:'verified'})),logout:vi.fn(async()=>{}),hydrateSession: vi.fn(async () => null), onAuthChange: vi.fn(() => () => {}) }));
const fetcher = vi.fn();
beforeEach(() => { vi.resetModules(); vi.stubGlobal('fetch', fetcher); fetcher.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });
it('password recovery requests omit a recipient and redemption rechecks the server session',async()=>{
 const sdk=await import('@netlify/identity'),{netlifyTransport}=await import('../src/lib/netlify');
 fetcher.mockResolvedValueOnce({json:async()=>({ok:true,data:null})});await netlifyTransport.requestPasswordRecovery!();
 expect(fetcher).toHaveBeenLastCalledWith('/.netlify/functions/auth?op=password-recovery',expect.objectContaining({credentials:'same-origin',body:'{}'}));
 fetcher.mockResolvedValueOnce({json:async()=>({ok:true,data:{uid:'verified',username:'member@example.test'}})});const user=await netlifyTransport.recoverPassword!('synthetic-recovery','synthetic-password');
 expect(sdk.recoverPassword).toHaveBeenCalledWith('synthetic-recovery','synthetic-password');expect(user.uid).toBe('verified');expect(fetcher).toHaveBeenLastCalledWith('/.netlify/functions/auth',expect.objectContaining({method:'GET'}));
});
it('a failed recovery clears any partially adopted SDK session and hides the raw response',async()=>{
 const sdk=await import('@netlify/identity'),{netlifyTransport}=await import('../src/lib/netlify');vi.mocked(sdk.recoverPassword).mockRejectedValueOnce(Error('raw-provider-token=secret'));
 await expect(netlifyTransport.recoverPassword!('fixture','synthetic-password')).rejects.toMatchObject({code:'RECOVERY_FAILED'});expect(sdk.logout).toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
});
it('recovery never adopts a different account from a stale server cookie',async()=>{
 const sdk=await import('@netlify/identity'),{netlifyTransport}=await import('../src/lib/netlify');fetcher.mockResolvedValueOnce({json:async()=>({ok:true,data:{uid:'different-user',username:'different@example.test'}})});
 await expect(netlifyTransport.recoverPassword!('fixture','synthetic-password')).rejects.toMatchObject({code:'UNAUTHENTICATED'});expect(sdk.logout).toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(1);
});
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
