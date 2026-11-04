import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aiService } from '../src/ai-service'
import { createGateway } from '../src/gateway'
import { createRelayHandler } from '../src/relay-http'
import { signedRelay, verifiedRelay } from '../src/relay-protocol'
import { fixtureDb, identity, actor, ownerConfig } from './feature-fixture'
import type { ReadingTask } from '@campus/contracts'

const secret = 'test-relay-secret-not-real-'.repeat(2), token = 'test-session-token-not-real'
process.env.AI_CHAT_BASE_URL = 'https://api.deepseek.com'
process.env.AI_CHAT_MODEL = 'fixture-model'
process.env.AI_CHAT_API_KEY = 'test-cloud-key-not-real'
process.env.AI_RELAY_SECRET = secret
process.env.AI_EXECUTION_MODE = 'netlify'
const output = '[R1](https://www.bjtu.edu.cn/test) 报名时间未说明。'
const start = { schoolId: 'bjtu', itemIds: ['notice'], requestId: 'request_relay_test', service: 'official', task: 'summary' }
function setup(complete: (...args: any[]) => Promise<string> = async () => output) {
  const f = fixtureDb(); let calls = 0, cloudModelCalls = 0
  const ai = aiService(f.db, f.repo, async () => { cloudModelCalls++; throw new Error('CloudBase must not execute models') })
  const gateway = createGateway(f.repo, ownerConfig, Date.now, { ai })
  const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), 'https://fixture-env.api.tcloudbasegateway.com/v1/functions/webAi')
    const authorization = (options?.headers as Record<string, string>).authorization
    const caller = authorization === `Bearer ${token}` ? actor : { ...actor, uid: 'other-owner' }
    return Response.json(await gateway(JSON.parse(String(options?.body)), caller))
  }) as typeof fetch
  const handler = createRelayHandler({ env: name => ({ AI_RELAY_SECRET: secret, CLOUDBASE_ENV_ID: 'fixture-env', AI_CHAT_API_KEY: 'test-netlify-key-not-real' })[name], fetch: fetcher, complete: async (...args) => { calls++; return complete(...args) } })
  const request = (id: string, step: number, connection?: unknown, auth = token) => new Request('https://reader.netlify.app/.netlify/functions/ai', { method: 'POST', headers: { origin: 'https://reader.netlify.app', authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'ai.step', input: { taskId: id, step, ...(connection ? { connection } : {}) } }) })
  return { f, ai, handler, request, calls: () => calls, cloudModelCalls: () => cloudModelCalls }
}

test('relay signatures reject tampering, old requests and missing secret', () => {
  const request = { phase: 'prepare' as const, taskId: 'task_abcdefghijkl', step: 0, leaseId: 'lease_abcdefghijkl', timestamp: Date.now() }
  const signed = signedRelay(request, secret)
  assert.equal(verifiedRelay(signed, secret).taskId, request.taskId)
  assert.throws(() => verifiedRelay({ ...signed, payload: signed.payload.replace('prepare', 'complete') }, secret), { code: 'RELAY_FORBIDDEN' })
  assert.throws(() => verifiedRelay(signed, secret, request.timestamp + 120001), { code: 'RELAY_FORBIDDEN' })
  assert.throws(() => verifiedRelay(signed, ''), { code: 'RELAY_NOT_CONFIGURED' })
})

test('Netlify executes real batch path; CloudBase only authorizes, claims and settles once', async () => {
  const s = setup(async connection => { assert.equal(connection.apiKey, 'test-netlify-key-not-real'); return output })
  let task = await s.ai.handle('ai.start', start, identity) as ReadingTask
  await assert.rejects(s.ai.handle('ai.step', { taskId: task.id, step: 0 }, identity), { code: 'AI_RELAY_REQUIRED' })
  for (let step = 0; step < 2; step++) {
    const result = await s.handler(s.request(task.id, step)); assert.equal(result.status, 200)
    task = ((await result.json()) as { data: ReadingTask }).data
  }
  assert.equal(task.state, 'complete'); assert.equal(s.calls(), 2); assert.equal(s.cloudModelCalls(), 0)
  await s.handler(s.request(task.id, 1))
  assert.equal(s.calls(), 2)
  const status = await s.ai.handle('ai.status', {}, identity) as any
  assert.deepEqual([status.quota.used, status.quota.held], [1, 0])
  const rows = JSON.stringify([...s.f.rows('web_ai_tasks').values()])
  for (const key of ['test-netlify-key-not-real', 'test-cloud-key-not-real', token, secret]) assert.equal(rows.includes(key), false)
})

test('parallel and repeated HTTP requests cannot perform a second paid call for one batch', async () => {
  let entered!: () => void, resolve!: (text: string) => void
  const ready = new Promise<void>(r => { entered = r })
  const s = setup(async () => { entered(); return new Promise<string>(r => { resolve = r }) })
  const task = await s.ai.handle('ai.start', start, identity) as ReadingTask
  const running = s.handler(s.request(task.id, 0)); await ready
  const replay = await s.handler(s.request(task.id, 0)); assert.equal(((await replay.json()) as { data: ReadingTask }).data.state, 'running')
  resolve(output); await running; assert.equal(s.calls(), 1)
})

test('unknown model outcomes retain holds and stop; definite rejection releases once', async () => {
  for (const [code, state, held] of [['MODEL_UNCERTAIN', 'uncertain', 1], ['KEY_REJECTED', 'failed', 0]]) {
    const s = setup(async () => { throw Object.assign(new Error('never expose private response'), { code }) })
    const task = await s.ai.handle('ai.start', start, identity) as ReadingTask
    const result = await s.handler(s.request(task.id, 0)); const text = await result.text()
    assert.equal(JSON.parse(text).data.state, state); assert.doesNotMatch(text, /private response/)
    assert.equal((await s.ai.handle('ai.status', {}, identity) as any).quota.held, held)
    await s.handler(s.request(task.id, 0)); assert.equal(s.calls(), 1)
  }
})

test('client cannot forge commit, execute another identity, or bypass model-key setup', async () => {
  const s = setup(), task = await s.ai.handle('ai.start', start, identity) as ReadingTask
  await assert.rejects(s.ai.handle('ai.relay', { payload: '{}', signature: '0'.repeat(64) }, identity), { code: 'RELAY_FORBIDDEN' })
  const denied = await s.handler(s.request(task.id, 0, undefined, 'other-session-not-real'))
  assert.equal(denied.status, 403); assert.equal(s.calls(), 0)
  const missing = createRelayHandler({ env: name => name === 'AI_RELAY_SECRET' ? secret : undefined, fetch: async () => { throw new Error('should not claim') } })
  assert.equal((await missing(s.request(task.id, 0))).status, 503)
  assert.equal(s.f.rows('web_ai_tasks').get(task.id)!.state, 'ready')
})

test('expired / revoked material and cancelled in-flight tasks cannot publish a relay result', async () => {
  const s = setup(), task = await s.ai.handle('ai.start', start, identity) as ReadingTask
  s.f.items.get('notice')!.aiProcessing = 'import_only'
  assert.equal((await s.handler(s.request(task.id, 0))).status, 400); assert.equal(s.calls(), 0)
  const expired = setup(), oldTask = await expired.ai.handle('ai.start', start, identity) as ReadingTask
  expired.f.rows('web_ai_tasks').get(oldTask.id)!.expireAt = new Date(Date.now() - 1).toISOString()
  assert.equal((await expired.handler(expired.request(oldTask.id, 0))).status, 400); assert.equal(expired.calls(), 0)
  const next = setup(async () => { await next.ai.handle('ai.cancel', { taskId: current.id }, identity); return output })
  const current = await next.ai.handle('ai.start', start, identity) as ReadingTask
  const result = await next.handler(next.request(current.id, 0))
  assert.equal(((await result.json()) as { data: ReadingTask }).data.state, 'cancelled')
  assert.equal((await next.ai.handle('ai.status', {}, identity) as any).quota.held, 0)
})

test('BYOK key stays within the Netlify invocation and uses no official quota', async () => {
  const s = setup(async connection => { assert.equal(connection.apiKey, 'test-byok-transient'); return output })
  const task = await s.ai.handle('ai.start', { ...start, service: 'byok', provider: 'deepseek', model: 'fixture-model' }, identity) as ReadingTask
  const result = await s.handler(s.request(task.id, 0, { provider: 'deepseek', model: 'fixture-model', apiKey: 'test-byok-transient' }))
  assert.equal(((await result.json()) as { data: ReadingTask }).data.state, 'ready')
  assert.equal(JSON.stringify([...s.f.rows('web_ai_tasks').values()]).includes('test-byok-transient'), false)
  assert.equal((await s.ai.handle('ai.status', {}, identity) as any).quota.held, 0)
})

test('readiness checks verify caller and shared secret without creating tasks or calling a model', async () => {
  const s = setup()
  const request = new Request('https://reader.netlify.app/.netlify/functions/ai', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'ai.status', input: {} }) })
  const response = await s.handler(request), status = await response.json() as any
  assert.equal(status.data.officialConfigured, true); assert.equal(status.data.quota.remaining, null)
  assert.equal(s.calls(), 0); assert.equal(s.f.rows('web_ai_tasks').size, 0)
  const signed = signedRelay({ phase: 'check', taskId: 'relay_status_probe', step: 0, leaseId: 'lease_status_probe', timestamp: Date.now() }, 'wrong-secret-not-real'.repeat(2))
  await assert.rejects(s.ai.handle('ai.relay', signed, identity), { code: 'RELAY_FORBIDDEN' })
})
