import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import https from 'node:https'
import dns from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { userCompletion, type Connection } from '../src/model-provider'

test('DeepSeek requests final text without thinking; other compatible endpoints omit its extension', async () => {
  const bodies: Record<string, any>[] = []
  mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }])
  mock.method(https, 'request', (_target: URL, options: any, onResponse: (response: any) => void) => {
    options.lookup('api.deepseek.com', { all: true }, (error: unknown, addresses: unknown) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]) })
    options.lookup('api.deepseek.com', {}, (error: unknown, address: string, family: number) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4) })
    const request = new EventEmitter() as any
    request.destroy = () => {}
    request.end = (payload: Buffer) => {
      bodies.push(JSON.parse(payload.toString()))
      queueMicrotask(() => {
        const response = new EventEmitter() as any
        response.statusCode = 200
        onResponse(response)
        response.emit('data', Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '已整理资料。' } }] })))
        response.emit('end')
      })
    }
    return request
  })
  syncBuiltinESMExports()
  try {
    const cases: Array<[Connection, string | undefined]> = [
      [{ provider: 'deepseek', model: 'deepseek-flash', apiKey: 'test-only-key' }, undefined],
      [{ provider: 'deepseek', model: 'deepseek-flash', apiKey: 'test-only-key' }, 'https://api.deepseek.com/v1/chat/completions'],
      [{ provider: 'deepseek', model: 'other-model', apiKey: 'test-only-key' }, 'https://compatible.example/v1/chat/completions'],
      [{ provider: 'openai', model: 'test-model', apiKey: 'test-only-key' }, undefined],
    ]
    for (const [connection, endpoint] of cases) {
      assert.equal(await userCompletion(connection, '阅读说明', '资料正文', 1200, endpoint), '已整理资料。')
    }
    assert.deepEqual(bodies[0]!.thinking, { type: 'disabled' })
    assert.deepEqual(bodies[1]!.thinking, { type: 'disabled' })
    assert.equal('thinking' in bodies[2]!, false)
    assert.equal('thinking' in bodies[3]!, false)
    assert.equal(bodies[0]!.max_tokens, 1200)
    assert.equal(bodies[3]!.max_completion_tokens, 1200)
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
  }
})
