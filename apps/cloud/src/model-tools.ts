import { randomUUID } from 'node:crypto';
import type { AiProviderProtocol } from '@campus/contracts';
import { reject } from './errors';
import { modelPayload, modelText } from './model-protocols';

export type WebToolName = 'web_search_deepseek' | 'deepseek_fetch_web_page';
export interface ToolCall { id: string; name: WebToolName; arguments: Record<string, string>; thoughtSignature?: string }
export interface ToolExchange { calls: ToolCall[]; results: string[]; continuation?: Array<Record<string, unknown>> }
export interface ToolOptions { enabled: boolean; exchanges: ToolExchange[] }
export interface ToolCompletion { text: string; calls: ToolCall[]; continuation?: Array<Record<string, unknown>> }
const invalid = (): never => reject('MODEL_FORMAT_INVALID', '模型返回了无效的工具调用，请检查模型是否支持工具；仍可使用侧栏手动搜索。');
const object = (value: any): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const definitions = [
  { name: 'web_search_deepseek', description: 'Return the current turn’s initial search leads. The program already searches the current question and school before model requests; repeated calls reuse that result without a new network search. Model-authored query text is ignored. Leads are not evidence; read chosen pages before citing them.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Compatibility field; ignored. The program searches the current question and school.' } }, required: ['query'], additionalProperties: false } },
  { name: 'deepseek_fetch_web_page', description: 'Read one approved public URL from this turn’s initial search results or web_search_deepseek. Only a successful read supplies evidence with an R reference. Never invent URLs or treat a snippet as read content.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Exact URL from this turn search results.' } }, required: ['url'], additionalProperties: false } },
];

function checkedCall(id: unknown, name: unknown, args: unknown, signature?: unknown): ToolCall {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id) || !definitions.some(tool => tool.name === name)) invalid();
  let value: any = args;
  try { if (typeof value === 'string' && value.length <= 8192) value = JSON.parse(value); } catch { invalid(); }
  const key = name === 'web_search_deepseek' ? 'query' : 'url';
  if (!object(value) || Object.keys(value).length !== 1 || typeof value[key] !== 'string' || !value[key].trim() || value[key].length > (key === 'query' ? 500 : 8192)) invalid();
  if (signature !== undefined && (typeof signature !== 'string' || signature.length > 20000)) invalid();
  return { id: id as string, name: name as WebToolName, arguments: { [key]: value[key].trim() }, ...(signature ? { thoughtSignature: signature as string } : {}) };
}

/** Tools are separate from ordinary reading, which still rejects any tool output. */
export function toolPayload(protocol: AiProviderProtocol, model: string, guide: string, content: string, maxTokens: number, openai: boolean, deepseek: boolean, options: ToolOptions): any {
  const base: any = modelPayload(protocol, model, guide, content, maxTokens, openai, deepseek);
  for (const exchange of options.exchanges) if (!exchange.calls.length || exchange.calls.length !== exchange.results.length || exchange.results.some(value => typeof value !== 'string')) invalid();
  if (!options.enabled && !options.exchanges.length) return base;
  if (protocol === 'openai-chat') {
    base.tools = definitions.map(tool => ({ type: 'function', function: tool }));
    base.tool_choice = options.enabled ? 'auto' : 'none'; base.parallel_tool_calls = false;
    for (const exchange of options.exchanges) base.messages.push(
      { role: 'assistant', content: null, tool_calls: exchange.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) },
      ...exchange.calls.map((call, index) => ({ role: 'tool', tool_call_id: call.id, content: exchange.results[index] })),
    );
  } else if (protocol === 'openai-responses') {
    base.tools = definitions.map(tool => ({ type: 'function', ...tool, strict: false }));
    base.tool_choice = options.enabled ? 'auto' : 'none'; base.parallel_tool_calls = false;
    for (const exchange of options.exchanges) base.input.push(
      ...(exchange.continuation || []),
      ...exchange.calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })),
      ...exchange.calls.map((call, index) => ({ type: 'function_call_output', call_id: call.id, output: exchange.results[index] })),
    );
  } else if (protocol === 'anthropic') {
    base.tools = definitions.map(({ parameters, ...tool }) => ({ ...tool, input_schema: parameters }));
    base.tool_choice = options.enabled ? { type: 'auto', disable_parallel_tool_use: true } : { type: 'none' };
    for (const exchange of options.exchanges) base.messages.push(
      { role: 'assistant', content: [...(exchange.continuation || []), ...exchange.calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }))] },
      { role: 'user', content: exchange.calls.map((call, index) => ({ type: 'tool_result', tool_use_id: call.id, content: exchange.results[index] })) },
    );
  } else {
    base.tools = [{ functionDeclarations: definitions.map(({ parameters, ...tool }) => ({ ...tool, parameters: { type: 'object', properties: parameters.properties, required: parameters.required } })) }];
    base.toolConfig = { functionCallingConfig: { mode: options.enabled ? 'AUTO' : 'NONE' } };
    for (const exchange of options.exchanges) base.contents.push(
      { role: 'model', parts: exchange.calls.map(call => ({ functionCall: { id: call.id, name: call.name, args: call.arguments }, ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) })) },
      { role: 'user', parts: exchange.calls.map((call, index) => ({ functionResponse: { id: call.id, name: call.name, response: { result: exchange.results[index] } } })) },
    );
  }
  return base;
}

export function toolResponse(protocol: AiProviderProtocol, value: any, enabled: boolean): ToolCompletion {
  let calls: ToolCall[] = [];
  let continuation: Array<Record<string, unknown>> | undefined;
  if (protocol === 'openai-chat') {
    const choice = value?.choices?.[0], raw = choice?.message?.tool_calls;
    if (raw?.length) {
      if (choice.finish_reason !== 'tool_calls' || !Array.isArray(raw) || raw.some((call: any) => call?.type !== 'function')) invalid();
      calls = raw.map((call: any) => checkedCall(call.id, call.function?.name, call.function?.arguments));
    }
  } else if (protocol === 'openai-responses') {
    const raw = value?.output;
    if (Array.isArray(raw) && raw.some(item => item?.type === 'function_call')) {
      if (value.status !== 'completed' || raw.some(item => !item || !['function_call', 'reasoning', 'message'].includes(item.type))) invalid();
      continuation = raw.filter(item => item.type === 'reasoning');
      calls = raw.filter(item => item.type === 'function_call').map(item => checkedCall(item.call_id, item.name, item.arguments));
    }
  } else if (protocol === 'anthropic') {
    const raw = value?.content;
    if (Array.isArray(raw) && raw.some(item => item?.type === 'tool_use')) {
      if (value.stop_reason !== 'tool_use' || raw.some(item => !item || !['tool_use', 'text', 'thinking', 'redacted_thinking'].includes(item.type))) invalid();
      continuation = raw.filter(item => ['thinking', 'redacted_thinking'].includes(item.type));
      calls = raw.filter(item => item.type === 'tool_use').map(item => checkedCall(item.id, item.name, item.input));
    }
  } else {
    const candidate = value?.candidates?.[0], parts = candidate?.content?.parts;
    if (Array.isArray(parts) && parts.some(part => part?.functionCall)) {
      if (candidate.finishReason !== 'STOP' || value?.promptFeedback?.blockReason || parts.some(part => !part || !part.functionCall && typeof part.text !== 'string')) invalid();
      calls = parts.filter(part => part.functionCall).map(part => checkedCall(part.functionCall.id || `call_${randomUUID()}`, part.functionCall.name, part.functionCall.args, part.thoughtSignature));
    }
  }
  if (!calls.length) return { text: modelText(protocol, value), calls: [] };
  if (!enabled || calls.length > 5 || new Set(calls.map(call => call.id)).size !== calls.length) invalid();
  if (continuation && JSON.stringify(continuation).length > 4000) invalid();
  return { text: '', calls, ...(continuation?.length ? { continuation } : {}) };
}
