import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => {
  const auth = {
    getSession: vi.fn<() => Promise<unknown>>(),
    signInWithPassword: vi.fn<(input: unknown) => Promise<unknown>>(),
    signOut: vi.fn<() => Promise<unknown>>(),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  }
  const callFunction = vi.fn<(input: unknown) => Promise<unknown>>()
  return { auth, callFunction, init: vi.fn((_config: unknown) => ({ auth, callFunction })) }
})
vi.mock('@cloudbase/js-sdk/app', () => ({ default: { init: sdk.init } }))
vi.mock('@cloudbase/js-sdk/auth', () => ({ registerAuth: vi.fn() }))
vi.mock('@cloudbase/js-sdk/functions', () => ({ registerFunctions: vi.fn() }))

const user = { id: 'sdk-verified-owner', is_anonymous: false }
const loggedIn = { data: { session: { user }, user }, error: null }
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks()
  vi.stubEnv('VITE_CLOUDBASE_ENV_ID', 'fixture-environment')
  vi.stubEnv('VITE_CLOUDBASE_REGION', 'ap-shanghai')
  vi.stubEnv('VITE_CLOUDBASE_PUBLISHABLE_KEY', '')
  vi.stubEnv('VITE_CLOUDBASE_PASSWORD_READY', 'true')
  vi.stubEnv('VITE_AI_EXECUTOR', 'cloudbase')
  sdk.auth.getSession.mockResolvedValue(loggedIn)
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it('Netlify mode sends only a batch to its same-origin executor, never retrying CloudBase models', async () => {
  vi.stubEnv('VITE_AI_EXECUTOR', 'netlify')
  sdk.auth.getSession.mockResolvedValue({ data: { session: { user, access_token: 'test-session-not-real' } }, error: null })
  const request = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, data: { id: 'task', state: 'ready' } }) })
  vi.stubGlobal('fetch', request)
  const { cloudTransport } = await import('../src/lib/cloudbase')
  await cloudTransport.call('ai.step', { taskId: 'task', step: 0 })
  expect(request).toHaveBeenCalledWith('/.netlify/functions/ai', expect.objectContaining({ method: 'POST', redirect: 'error', headers: expect.objectContaining({ authorization: 'Bearer test-session-not-real' }) }))
  expect(sdk.callFunction).not.toHaveBeenCalled()
  await cloudTransport.call('ai.status', {})
  expect(request).toHaveBeenLastCalledWith('/.netlify/functions/ai', expect.objectContaining({ body: JSON.stringify({ action: 'ai.status', input: {} }) }))
  request.mockRejectedValue(new Error('token=must-not-appear'))
  await expect(cloudTransport.call('ai.step', { taskId: 'task', step: 0 })).rejects.toMatchObject({ code: 'AI_CONNECTION_FAILED' })
  expect(sdk.callFunction).not.toHaveBeenCalled()
})

it('password-authenticated mode does not require or invent a Publishable Key', async () => {
  const { cloudTransport, setupIssues } = await import('../src/lib/cloudbase')
  expect(setupIssues).toEqual([])
  expect(await cloudTransport.restore()).toEqual({ uid: user.id, username: null })
  expect(sdk.init).toHaveBeenCalledWith(expect.objectContaining({ env: 'fixture-environment', region: 'ap-shanghai', persistence: 'session' }))
  expect(sdk.init.mock.calls[0]?.[0]).not.toHaveProperty('accessKey')
})
it('a UID without a real session is not a login', async () => {
  sdk.auth.getSession.mockResolvedValue({ data: { user, session: null }, error: null })
  const { cloudTransport } = await import('../src/lib/cloudbase')
  expect(await cloudTransport.restore()).toBeNull()
  await expect(cloudTransport.call('session.get', {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  expect(sdk.callFunction).not.toHaveBeenCalled()
})
it('anonymous and malformed sessions are refused before calling the gateway', async () => {
  const { cloudTransport } = await import('../src/lib/cloudbase')
  for (const invalid of [{ ...user, is_anonymous: true }, { ...user, id: '' }, { ...user, id: 123 }]) {
    sdk.auth.getSession.mockResolvedValue({ data: { session: { user: invalid } }, error: null })
    expect(await cloudTransport.restore()).toBeNull()
  }
  expect(sdk.callFunction).not.toHaveBeenCalled()
})
it('sign-in uses the actual v3 password method and requires a returned session', async () => {
  sdk.auth.signInWithPassword.mockResolvedValue(loggedIn)
  const { cloudTransport } = await import('../src/lib/cloudbase')
  expect(await cloudTransport.signIn(' owner ', 'test-transient-password')).toEqual({ uid: user.id, username: null })
  expect(sdk.auth.signInWithPassword).toHaveBeenCalledWith({ username: 'owner', password: 'test-transient-password' })
  sdk.auth.signInWithPassword.mockResolvedValue({ data: { user }, error: null })
  await expect(cloudTransport.signIn('owner', 'test-transient-password')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
})
it('calls only the named gateway envelope, without browser owner fields', async () => {
  sdk.callFunction.mockResolvedValue({ result: { ok: true, data: { items: [], nextCursor: null } } })
  const { cloudTransport } = await import('../src/lib/cloudbase')
  expect(await cloudTransport.call('feed.list', { schoolId: 'bjtu' })).toEqual({ items: [], nextCursor: null })
  expect(sdk.callFunction).toHaveBeenCalledWith({ name: 'webGateway', data: { action: 'feed.list', input: { schoolId: 'bjtu' } } })
})
it('routes AI operations only to the separate worker without retrying on another gateway', async () => {
  sdk.callFunction.mockResolvedValue({ result: { ok: true, data: {} } })
  const { cloudTransport } = await import('../src/lib/cloudbase')
  await cloudTransport.call('ai.status', {})
  expect(sdk.callFunction).toHaveBeenCalledWith({ name: 'webAi', data: { action: 'ai.status', input: {} } })
  sdk.callFunction.mockRejectedValue({ code: 'function_not_found', message: 'secret' })
  await expect(cloudTransport.call('ai.status', {})).rejects.toMatchObject({ code: 'AI_WORKER_REQUIRED' })
  expect(sdk.callFunction).toHaveBeenCalledTimes(2)
})
it('identifies missing worker owner configuration without implying the existing login failed', async () => {
  sdk.callFunction.mockResolvedValue({ result: { ok: false, code: 'OWNER_NOT_CONFIGURED', message: 'generic' } })
  const { cloudTransport } = await import('../src/lib/cloudbase')
  await expect(cloudTransport.call('ai.status', {})).rejects.toMatchObject({ code: 'OWNER_NOT_CONFIGURED', message: expect.stringContaining('webAi 尚未配置 WEB_OWNER_UID') })
})
it('SDK errors never echo a raw token-bearing message', async () => {
  sdk.auth.signInWithPassword.mockResolvedValue({ data: {}, error: { code: 'network_error', message: 'token=secret-body' } })
  const { cloudTransport } = await import('../src/lib/cloudbase')
  await expect(cloudTransport.signIn('owner', 'test-password')).rejects.not.toHaveProperty('message', expect.stringContaining('secret-body'))
  sdk.callFunction.mockRejectedValue({ code: 'function_not_found' })
  await expect(cloudTransport.call('session.get', {})).rejects.toMatchObject({ code: 'GATEWAY_NOT_DEPLOYED' })
})
it('SDK unauthenticated on a fresh visit is a normal empty session, with no gateway call', async () => {
  sdk.auth.getSession.mockResolvedValue({ data: { session: null }, error: { code: 'unauthenticated', category: 'INVALID_CREDENTIALS' } })
  const { cloudTransport } = await import('../src/lib/cloudbase')
  expect(await cloudTransport.restore()).toBeNull()
  expect(sdk.callFunction).not.toHaveBeenCalled()
  await expect(cloudTransport.call('session.get', {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
})
it('normalizes a rejected unauthenticated SDK session without hiding a real network failure', async () => {
  const { cloudTransport } = await import('../src/lib/cloudbase')
  sdk.auth.getSession.mockRejectedValue({ code: 'unauthenticated' })
  expect(await cloudTransport.restore()).toBeNull()
  sdk.auth.getSession.mockResolvedValue({ data: {}, error: { code: 'unreachable' } })
  await expect(cloudTransport.restore()).rejects.toMatchObject({ code: 'CLOUD_UNAVAILABLE', message: expect.stringContaining('检查登录状态') })
})
it('distinguishes an unset password, invalid password, and failed login request', async () => {
  const { cloudTransport } = await import('../src/lib/cloudbase')
  for (const [code, expected] of [['password_not_set','PASSWORD_NOT_SET'], ['invalid_username_or_password','LOGIN_FAILED'], ['unreachable','CLOUD_UNAVAILABLE']]) {
    sdk.auth.signInWithPassword.mockResolvedValue({ data: {}, error: { code } })
    await expect(cloudTransport.signIn('owner', 'fixture-password')).rejects.toMatchObject({ code: expected })
  }
  sdk.auth.signInWithPassword.mockRejectedValue({ code: 'unreachable', message: 'private-key=fixture' })
  await expect(cloudTransport.signIn('owner', 'fixture-password')).rejects.toMatchObject({ message: expect.stringContaining('登录请求未完成') })
})
it('missing region remains a configuration error, not a guessed deployment', async () => {
  vi.stubEnv('VITE_CLOUDBASE_REGION', '')
  const { cloudTransport, setupIssues } = await import('../src/lib/cloudbase')
  expect(setupIssues).toContain('确认并填写环境地域')
  await expect(cloudTransport.restore()).rejects.toMatchObject({ code: 'SETUP_REQUIRED' })
  expect(sdk.init).not.toHaveBeenCalled()
})
