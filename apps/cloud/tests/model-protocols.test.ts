import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import type { AiProviderProtocol } from '@campus/contracts';
import { userCompletion, type Connection } from '../src/model-provider';
import { modelText } from '../src/model-protocols';
import { normalizeProviderBaseUrl, providerEndpoint, publicAddress } from '../src/provider-endpoints';

const replies: Record<AiProviderProtocol, unknown> = {
  'openai-chat': { choices: [{ finish_reason: 'stop', message: { content: '回答' } }] },
  'openai-responses': { status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '回答' }] }] },
  anthropic: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'do not display' }, { type: 'text', text: '回答' }] },
  gemini: { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'do not display' }, { text: '回答' }] } }] },
};
const connection = (protocol: AiProviderProtocol): Connection => ({ provider: 'custom', protocol, endpoint: providerEndpoint(protocol, 'https://provider.example/v1', 'fixture-model'), model: 'fixture-model', apiKey: 'synthetic-key' });

test('four protocols send isolated credentials and correct text schemas through pinned HTTPS', async () => {
  let protocol: AiProviderProtocol = 'openai-chat';
  const captured: Array<{ target: URL; headers: any; body: any }> = [];
  mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  mock.method(https, 'request', (target: URL, options: any, receive: (response: any) => void) => {
    options.lookup('provider.example', {}, (error: unknown, address: string, family: number) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
    const request = new EventEmitter() as any; request.destroy = () => {};
    request.end = (payload: Buffer) => {
      captured.push({ target, headers: options.headers, body: JSON.parse(payload.toString()) });
      queueMicrotask(() => { const response = new EventEmitter() as any; response.statusCode = 200; receive(response); response.emit('data', Buffer.from(JSON.stringify(replies[protocol]))); response.emit('end'); });
    }; return request;
  });
  syncBuiltinESMExports();
  try {
    for (protocol of Object.keys(replies) as AiProviderProtocol[]) assert.equal(await userCompletion(connection(protocol), '系统说明', '资料', 1300), '回答');
    const [chat, responses, anthropic, gemini] = captured;
    assert.equal(chat.target.pathname, '/v1/chat/completions'); assert.equal(chat.body.max_tokens, 1300); assert.equal(chat.body.thinking, undefined);
    assert.deepEqual(chat.body.messages, [{ role: 'system', content: '系统说明' }, { role: 'user', content: '资料' }]);
    assert.equal(responses.target.pathname, '/v1/responses'); assert.deepEqual(responses.body.input, chat.body.messages); assert.equal(responses.body.store, false); assert.equal(responses.body.max_output_tokens, 1300);
    assert.equal(anthropic.target.pathname, '/v1/messages'); assert.equal(anthropic.body.system, '系统说明'); assert.deepEqual(anthropic.body.messages, [{ role: 'user', content: '资料' }]); assert.equal(anthropic.headers['anthropic-version'], '2023-06-01');
    assert.equal(gemini.target.pathname, '/v1/models/fixture-model:generateContent'); assert.deepEqual(gemini.body.systemInstruction, { parts: [{ text: '系统说明' }] }); assert.deepEqual(gemini.body.contents, [{ role: 'user', parts: [{ text: '资料' }] }]); assert.equal(gemini.body.generationConfig.maxOutputTokens, 1300);
    for (let i = 0; i < captured.length; i++) {
      const headers = captured[i].headers;
      assert.equal(Object.values(headers).filter(v => String(v).includes('synthetic-key')).length, 1);
      assert.equal(String(captured[i].target).includes('synthetic-key'), false);
      assert.equal(JSON.stringify(captured[i].body).includes('synthetic-key'), false);
      assert.equal(headers[i < 2 ? 'authorization' : i === 2 ? 'x-api-key' : 'x-goog-api-key'], i < 2 ? 'Bearer synthetic-key' : 'synthetic-key');
    }
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});

test('partial output, tools, filters and unfinished responses never become accepted text', () => {
  const cases: Array<[AiProviderProtocol, unknown, string]> = [
    ['openai-responses', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'OUTPUT_TRUNCATED'],
    ['openai-responses', { status: 'in_progress', output: [] }, 'MODEL_FORMAT_INVALID'],
    ['openai-responses', { status: 'completed', output: [{ type: 'function_call' }] }, 'MODEL_FORMAT_INVALID'],
    ['openai-responses', { status: 'completed', output: [{ type: 'message', status: 'incomplete', content: [{ type: 'output_text', text: 'partial' }] }] }, 'MODEL_FORMAT_INVALID'],
    ['openai-responses', { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_audio' }, { type: 'output_text', text: 'partial' }] }] }, 'MODEL_FORMAT_INVALID'],
    ['openai-responses', { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }, 'PROVIDER_CONTENT_FILTER'],
    ['anthropic', { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }] }, 'OUTPUT_TRUNCATED'],
    ['anthropic', { stop_reason: 'tool_use', content: [{ type: 'tool_use' }] }, 'MODEL_FORMAT_INVALID'],
    ['anthropic', { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hidden' }] }, 'MODEL_FORMAT_INVALID'],
    ['anthropic', { stop_reason: 'end_turn', content: [{ type: 'server_tool_use' }, { type: 'text', text: 'partial' }] }, 'MODEL_FORMAT_INVALID'],
    ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'OUTPUT_TRUNCATED'],
    ['gemini', { promptFeedback: { blockReason: 'SAFETY' } }, 'PROVIDER_CONTENT_FILTER'],
    ['gemini', { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: {} }, { text: 'partial' }] } }] }, 'MODEL_FORMAT_INVALID'],
    ['gemini', { candidates: [{ finishReason: 'STOP', content: { parts: [{ executableCode: {} }, { text: 'partial' }] } }] }, 'MODEL_FORMAT_INVALID'],
  ];
  for (const [protocol, value, code] of cases) assert.throws(() => modelText(protocol, value), { code });
});

test('endpoints normalize complete API paths and encode Gemini model IDs without allowing private destinations', () => {
  assert.equal(normalizeProviderBaseUrl('https://api.example/v1/chat/completions/', 'openai-chat'), 'https://api.example/v1');
  assert.equal(normalizeProviderBaseUrl('https://api.example/v1/responses', 'openai-responses'), 'https://api.example/v1');
  assert.equal(normalizeProviderBaseUrl('https://api.example/v1/messages', 'anthropic'), 'https://api.example/v1');
  assert.equal(providerEndpoint('gemini', 'https://api.example/v1beta', 'models/fixture-model'), 'https://api.example/v1beta/models/fixture-model:generateContent');
  assert.equal(new URL(providerEndpoint('gemini', 'https://api.example/v1beta', 'a/../../b')).pathname, '/v1beta/models/a%2F..%2F..%2Fb:generateContent');
  for (const value of ['http://api.example', 'https://user:pass@api.example', 'https://api.example?key=x', 'https://api.example:8443', 'https://127.0.0.1', 'https://169.254.169.254', 'https://my.internal']) assert.throws(() => normalizeProviderBaseUrl(value, 'openai-chat'));
  for (const ip of ['127.0.0.1', '169.254.169.254', '10.1.2.3', '100.64.1.1', '172.16.0.1', '192.168.0.1', '::1']) assert.equal(publicAddress(ip), false, ip);
});

test('mixed public/private DNS prevents requests; redirects and error bodies are destroyed without following or disclosure', async () => {
  let addresses = [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], requests = 0, status = 302, destroyed = 0;
  mock.method(dns, 'lookup', async () => addresses);
  mock.method(https, 'request', (_target: URL, _options: any, receive: (response: any) => void) => {
    requests++; const request = new EventEmitter() as any; request.destroy = () => { destroyed++; };
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter() as any; response.statusCode = status; response.headers = { location: 'https://127.0.0.1/private' }; response.destroy = () => { destroyed++; }; receive(response);
      if (status === 200) { response.emit('data', Buffer.alloc(256001)); response.emit('end'); }
    }); return request;
  }); syncBuiltinESMExports();
  try {
    await assert.rejects(userCompletion(connection('gemini'), 'guide', 'body'), { code: 'CONNECTION_FAILED' }); assert.equal(requests, 0);
    addresses = [{ address: '8.8.8.8', family: 4 }];
    for (status of [302, 401, 429, 500]) { await assert.rejects(userCompletion(connection('gemini'), 'guide', 'body'), error => !String(error).includes('synthetic-key')); }
    assert.equal(requests, 4); assert.equal(destroyed, 8);
    status = 200; await assert.rejects(userCompletion(connection('gemini'), 'guide', 'body'), { code: 'RESPONSE_TOO_LARGE' });
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});
