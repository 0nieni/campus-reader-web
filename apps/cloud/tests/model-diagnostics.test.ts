import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnoseOfficial, providerHttpCode } from '../src/model-diagnostics';

const connection = { provider: 'deepseek', model: 'fixture-model', apiKey: 'fixture-private-key' } as const;
const endpoint = 'https://api.deepseek.com/chat/completions';
function fixtures(balance: unknown, models: unknown, status = 200) {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const request = (async (url: string, options: RequestInit) => {
    calls.push({ url, options });
    return Response.json(calls.length === 1 ? balance : models, { status });
  }) as typeof fetch;
  return { calls, request };
}
test('read-only diagnosis validates key, available balance and model without a completion or retaining account amounts', async () => {
  const f = fixtures({ is_available: true, balance_infos: [{ total_balance: 'private-amount' }] }, { data: [{ id: connection.model }] });
  const result = await diagnoseOfficial(connection, endpoint, f.request);
  assert.equal(result.code, 'READY');
  assert.deepEqual(f.calls.map(call => call.url), ['https://api.deepseek.com/user/balance', 'https://api.deepseek.com/models']);
  for (const call of f.calls) {
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'error'); assert.equal(call.options.body, undefined);
    assert.equal((call.options.headers as any).authorization, `Bearer ${connection.apiKey}`);
  }
  assert.ok(!JSON.stringify(result).includes('private-amount')); assert.ok(!JSON.stringify(result).includes(connection.apiKey));
});
test('diagnosis separates invalid key, insufficient balance, missing model and unsafe destinations', async () => {
  for (const [status, code] of [[401, 'KEY_REJECTED'], [402, 'BALANCE_REQUIRED'], [429, 'PROVIDER_LIMIT']] as const) {
    const f = fixtures({ error: { message: connection.apiKey } }, {}, status);
    const result = await diagnoseOfficial(connection, endpoint, f.request);
    assert.equal(result.code, code); assert.ok(!JSON.stringify(result).includes(connection.apiKey)); assert.equal(f.calls.length, 1);
  }
  const empty = fixtures({ is_available: false }, {});
  assert.equal((await diagnoseOfficial(connection, endpoint, empty.request)).code, 'BALANCE_REQUIRED'); assert.equal(empty.calls.length, 1);
  const missing = fixtures({ is_available: true }, { data: [{ id: 'other-model' }] });
  assert.equal((await diagnoseOfficial(connection, endpoint, missing.request)).code, 'MODEL_UNSUPPORTED');
  const none = fixtures({}, {});
  for (const target of ['https://attacker.test/chat/completions', 'https://api.deepseek.com/chat/completions?key=bad', 'https://api.deepseek.com.evil.test/chat/completions']) {
    assert.equal((await diagnoseOfficial(connection, target, none.request)).code, 'CHECK_UNSUPPORTED');
  }
  assert.equal(none.calls.length, 0); assert.equal(providerHttpCode(422), 'MODEL_OR_CONTEXT_INVALID');
});
test('diagnosis hides timeouts, malformed metadata and oversized responses without retrying', async () => {
  for (const body of [{}, { is_available: 'true' }]) {
    const f = fixtures(body, {});
    assert.equal((await diagnoseOfficial(connection, endpoint, f.request)).code, 'CHECK_FAILED'); assert.equal(f.calls.length, 1);
  }
  let calls = 0;
  const fail = (async () => { calls++; throw new Error(connection.apiKey); }) as typeof fetch;
  const result = await diagnoseOfficial(connection, endpoint, fail);
  assert.equal(result.code, 'CHECK_FAILED'); assert.ok(!result.message.includes(connection.apiKey)); assert.equal(calls, 1);
  const large = (async () => new Response('x'.repeat(256001))) as typeof fetch;
  assert.equal((await diagnoseOfficial(connection, endpoint, large)).code, 'CHECK_FAILED');
});
