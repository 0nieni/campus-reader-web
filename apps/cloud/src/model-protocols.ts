import type { AiProviderProtocol } from '@campus/contracts';
import { reject } from './errors';

export function modelPayload(protocol: AiProviderProtocol, model: string, guide: string, content: string, maxTokens: number, openai: boolean, deepseek: boolean) {
  const messages = [{ role: 'system', content: guide }, { role: 'user', content }];
  if (protocol === 'openai-chat') return { model, stream: false, messages, thinking: deepseek ? { type: 'disabled' } : undefined, store: openai ? false : undefined, ...(openai ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }) };
  if (protocol === 'openai-responses') return { model, stream: false, store: false, max_output_tokens: maxTokens, input: messages };
  if (protocol === 'anthropic') return { model, stream: false, system: guide, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
  return { systemInstruction: { parts: [{ text: guide }] }, contents: [{ role: 'user', parts: [{ text: content }] }], generationConfig: { maxOutputTokens: maxTokens } };
}
export function modelHeaders(protocol: AiProviderProtocol, key: string): Record<string, string> {
  return protocol === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : protocol === 'gemini' ? { 'x-goog-api-key': key } : { authorization: `Bearer ${key}` };
}
export function modelText(protocol: AiProviderProtocol, value: any): string {
  let text: unknown;
  if (protocol === 'openai-chat') {
    const choice = value?.choices?.[0];
    if (choice?.finish_reason === 'length') reject('OUTPUT_TRUNCATED', '模型输出达到长度上限，未完整结束。');
    if (choice?.finish_reason === 'content_filter') reject('PROVIDER_CONTENT_FILTER', '服务商内容过滤终止了本批生成。');
    if (['insufficient_system_resource','aborted'].includes(choice?.finish_reason)) reject('PROVIDER_INTERRUPTED', '服务商中断了本批生成。');
    if (choice?.finish_reason !== 'stop' || choice?.message?.tool_calls?.length || choice?.message?.function_call) reject('MODEL_FORMAT_INVALID', '模型返回了不支持的结束状态或工具调用。');
    text = choice?.message?.content;
  } else if (protocol === 'openai-responses') {
    if (value?.status === 'incomplete') reject(value?.incomplete_details?.reason === 'max_output_tokens' ? 'OUTPUT_TRUNCATED' : 'PROVIDER_INTERRUPTED', '服务商未完整结束本批生成。');
    if (value?.status !== 'completed' || !Array.isArray(value.output) || value.output.some((item: any) => !item || !['message','reasoning'].includes(item.type) || (item.type === 'message' && (!Array.isArray(item.content) || (item.status !== undefined && item.status !== 'completed') || (item.role !== undefined && item.role !== 'assistant'))))) reject('MODEL_FORMAT_INVALID', '服务商未返回完整的文本回答。');
    const parts = value.output.filter((item: any) => item.type === 'message').flatMap((item: any) => item.content);
    if (parts.some((part: any) => !part || !['output_text','refusal'].includes(part.type))) reject('MODEL_FORMAT_INVALID', '服务商返回了不支持的文本内容。');
    if (parts.some((part: any) => part.type === 'refusal')) reject('PROVIDER_CONTENT_FILTER', '服务商拒绝了本次生成。');
    text = parts.filter((part: any) => part.type === 'output_text').map((part: any) => part.text).filter((part: unknown) => typeof part === 'string').join('\n');
  } else if (protocol === 'anthropic') {
    if (value?.stop_reason === 'max_tokens') reject('OUTPUT_TRUNCATED', '模型输出达到长度上限，未完整结束。');
    if (value?.stop_reason === 'refusal') reject('PROVIDER_CONTENT_FILTER', '服务商拒绝了本次生成。');
    if (value?.stop_reason !== 'end_turn' || !Array.isArray(value.content) || value.content.some((part: any) => !part || !['text','thinking','redacted_thinking'].includes(part.type))) reject('MODEL_FORMAT_INVALID', '服务商未返回完整的文本回答。');
    text = value.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).filter((part: unknown) => typeof part === 'string').join('\n');
  } else {
    const candidate = value?.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') reject('OUTPUT_TRUNCATED', '模型输出达到长度上限，未完整结束。');
    if (value?.promptFeedback?.blockReason || ['SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII'].includes(candidate?.finishReason)) reject('PROVIDER_CONTENT_FILTER', '服务商内容过滤终止了本批生成。');
    if (candidate?.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts) || candidate.content.parts.some((part: any) => !part || part.functionCall || typeof part.text !== 'string')) reject('MODEL_FORMAT_INVALID', '服务商未返回完整的文本回答。');
    text = candidate.content.parts.filter((part: any) => !part.thought && typeof part.text === 'string').map((part: any) => part.text).join('\n');
  }
  if (typeof text !== 'string' || !text.trim()) reject('MODEL_FORMAT_INVALID', '服务商未返回可阅读的文本，请检查模型及接口协议。');
  return text.trim();
}
