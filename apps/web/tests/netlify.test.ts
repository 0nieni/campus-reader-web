import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('@netlify/identity', () => ({ confirmEmail:vi.fn(async()=>({id:'verified'})),handleAuthCallback:vi.fn(async()=>({type:'confirmation',user:{id:'verified'}})),recoverPassword:vi.fn(async()=>({id:'verified'})),logout:vi.fn(async()=>{}),hydrateSession: vi.fn(async () => null), onAuthChange: vi.fn(() => () => {}) }));
const fetcher = vi.fn();
beforeEach(() => { vi.resetModules(); vi.stubGlobal('fetch', fetcher); fetcher.mockReset(); history.replaceState(null,'','/'); });
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
  const sdk=await import('@netlify/identity'),{netlifyTransport}=await import('../src/lib/netlify');
  fetcher.mockResolvedValueOnce({json:async()=>({ok:true,data:{verificationRequired:true}})});
  await netlifyTransport.signUp!(' new@example.test ','synthetic-password');
  expect(fetcher).toHaveBeenLastCalledWith('/.netlify/functions/auth?op=signup',expect.objectContaining({credentials:'same-origin',redirect:'error',body:JSON.stringify({email:'new@example.test',password:'synthetic-password'})}));
  history.replaceState(null,'','/#confirmation_token=synthetic-token');
  fetcher.mockResolvedValueOnce({json:async()=>({ok:true,data:{uid:'verified',username:'new@example.test'}})});
  const value=await netlifyTransport.confirmEmail!('synthetic-token');expect(value.uid).toBe('verified');expect(sdk.handleAuthCallback).toHaveBeenCalledTimes(1);expect(sdk.confirmEmail).not.toHaveBeenCalled();expect(fetcher).toHaveBeenLastCalledWith('/.netlify/functions/auth',expect.objectContaining({method:'GET',credentials:'same-origin'}));
});
it.each([[404,'CONFIRMATION_INVALID'],[429,'CONFIRMATION_RATE_LIMITED'],[503,'CONFIRMATION_UNAVAILABLE'],[undefined,'CONFIRMATION_CONNECTION_FAILED']] as const)('confirmation classifies SDK failure %s without echoing a raw response or retrying',async(status,code)=>{
 const sdk=await import('@netlify/identity'),{netlifyTransport}=await import('../src/lib/netlify');
 history.replaceState(null,'','/#confirmation_token=synthetic-token');
 vi.mocked(sdk.handleAuthCallback).mockRejectedValueOnce(Object.assign(Error('raw-secret-token'),{cause:{status}}));
 const error=await netlifyTransport.confirmEmail!('synthetic-token').catch(error=>error);
 expect(error.code).toBe(code);expect(error.message).not.toContain('raw-secret');expect(sdk.handleAuthCallback).toHaveBeenCalledTimes(1);expect(fetcher).not.toHaveBeenCalled();expect(sdk.logout).toHaveBeenCalled();
});
it('confirmation rejects a stale server cookie for a different account',async()=>{
 const sdk=await import('@netlify/identity'),{netlifyTransport}=await import('../src/lib/netlify');history.replaceState(null,'','/#confirmation_token=synthetic-token');
 fetcher.mockResolvedValueOnce({json:async()=>({ok:true,data:{uid:'other-account',username:'other@example.test'}})});
 await expect(netlifyTransport.confirmEmail!('synthetic-token')).rejects.toMatchObject({code:'CONFIRMATION_SESSION_FAILED'});expect(sdk.logout).toHaveBeenCalled();
});
it('confirmation does not redeem an absent or different callback token',async()=>{
 const sdk=await import('@netlify/identity'),{netlifyTransport}=await import('../src/lib/netlify');
 await expect(netlifyTransport.confirmEmail!('synthetic-token')).rejects.toMatchObject({code:'CONFIRMATION_INVALID'});expect(sdk.handleAuthCallback).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
});
