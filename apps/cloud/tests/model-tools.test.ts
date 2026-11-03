import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as protocols from '../src/model-protocols';

const call = { id: 'call_1', name: 'web_search_deepseek', arguments: { query: 'TypeScript 教程' } };
const options = { enabled: true, exchanges: [{ calls: [call], results: ['{"candidates":[]}'] }] };
const api = () => {
  assert.equal(typeof (protocols as any).toolPayload, 'function', 'model tools must build real provider payloads');
  return protocols as any;
};

test('all four protocols round-trip a search call and the matching result with automatic tool choice', () => {
  const p = api();
  const payload = (protocol: string) => p.toolPayload(protocol, 'model', 'guide', 'question', 1000, false, true, options);
  const chat = payload('openai-chat');
  assert.equal(chat.tool_choice, 'auto');
  assert.equal(chat.messages[2].tool_calls[0].function.name, 'web_search_deepseek');
  assert.equal(chat.messages[3].tool_call_id, 'call_1');
  assert.deepEqual(chat.thinking, { type: 'disabled' });
  const responses = payload('openai-responses');
  assert.equal(responses.input[2].type, 'function_call');
  assert.equal(responses.input[3].call_id, 'call_1');
  const anthropic = payload('anthropic');
  assert.equal(anthropic.messages[1].content[0].type, 'tool_use');
  assert.equal(anthropic.messages[2].content[0].tool_use_id, 'call_1');
  const gemini = payload('gemini');
  assert.equal(gemini.contents[1].parts[0].functionCall.name, 'web_search_deepseek');
  assert.equal(gemini.contents[2].parts[0].functionResponse.name, 'web_search_deepseek');
});

test('tool calls normalize from each protocol, preserving Gemini thought signatures for replay', () => {
  const p = api();
  const samples = [
    ['openai-chat', { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] }],
    ['openai-responses', { status: 'completed', output: [{ type: 'function_call', call_id: 'call_1', name: call.name, arguments: JSON.stringify(call.arguments) }] }],
    ['anthropic', { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_1', name: call.name, input: call.arguments }] }],
    ['gemini', { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { id: 'call_1', name: call.name, args: call.arguments }, thoughtSignature: 'opaque-signature' }] } }] }],
  ];
  for (const [protocol, sample] of samples) {
    const result = p.toolResponse(protocol, sample, true);
    assert.equal(result.calls[0].id, 'call_1');
    assert.equal(result.calls[0].name, call.name);
    assert.deepEqual(result.calls[0].arguments, call.arguments);
    if (protocol === 'gemini') {
      assert.equal(result.calls[0].thoughtSignature, 'opaque-signature');
      const replay = p.toolPayload('gemini', 'model', 'guide', 'question', 1000, false, false, { enabled: true, exchanges: [{ calls: result.calls, results: ['done'] }] });
      assert.equal(replay.contents[1].parts[0].thoughtSignature, 'opaque-signature');
    }
  }
});

test('malformed, unknown, disabled or duplicate calls never become executable instructions', () => {
  const p = api();
  const response = (calls: any[], reason = 'tool_calls') => ({ choices: [{ finish_reason: reason, message: { tool_calls: calls } }] });
  const raw = { id: 'call_1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
  for (const value of [
    response([raw], 'length'), response([raw], 'content_filter'), response([raw], 'stop'), response([raw, raw]),
    response([{ ...raw, function: { name: 'run_shell', arguments: '{}' } }]),
    response([{ ...raw, function: { name: call.name, arguments: '{' } }]),
    response([{ ...raw, function: { name: call.name, arguments: '{"query":"x","apiKey":"secret"}' } }]),
  ]) assert.throws(() => p.toolResponse('openai-chat', value, true));
  assert.throws(() => p.toolResponse('openai-chat', response([raw]), false));
  assert.throws(() => p.toolPayload('openai-chat', 'm', 'g', 'q', 100, false, true, { enabled: true, exchanges: [{ calls: [call], results: [] }] }));
  const disabled = p.toolPayload('openai-chat', 'm', 'g', 'q', 100, false, true, { enabled: false, exchanges: [] });
  assert.equal(disabled.tools, undefined, 'a local-only turn must work on models without tool support');
});

test('reasoning continuation accompanying a Responses tool call is returned to the same model intact', () => {
  const p = api();
  const reasoning = { type: 'reasoning', id: 'reasoning_1', summary: [], encrypted_content: 'opaque-encrypted-state' };
  const value = { status: 'completed', output: [reasoning, { type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }] };
  const result = p.toolResponse('openai-responses', value, true);
  assert.deepEqual(result.continuation, [reasoning]);
  const replay = p.toolPayload('openai-responses', 'm', 'g', 'q', 100, true, false, { enabled: true, exchanges: [{ ...result, results: ['done'] }] });
  assert.deepEqual(replay.input[2], reasoning);
});
