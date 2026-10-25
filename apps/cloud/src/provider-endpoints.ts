import { isIP } from 'node:net';
import type { AiProviderProtocol, AiProviderRef } from '@campus/contracts';
import { reject } from './errors';

export function checkedProtocol(value: unknown): AiProviderProtocol {
  if (!['openai-chat', 'openai-responses', 'anthropic', 'gemini'].includes(String(value))) reject('VALIDATION_FAILED', '请选择受支持的接口协议。');
  return value as AiProviderProtocol;
}
export function checkedModel(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,100}$/.test(value)) reject('MODEL_INVALID', '请填写服务商提供的模型 ID。');
  return value;
}
export function checkedProviderRef(value: unknown): AiProviderRef {
  const ref = value as AiProviderRef;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(k => !['id','version'].includes(k)) || typeof ref.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(ref.id) || !Number.isSafeInteger(ref.version) || ref.version < 1) reject('VALIDATION_FAILED', '服务商配置编号或版本无效，请刷新配置。');
  return { id: ref.id, version: ref.version };
}
export function publicAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a = 0,b = 0,c = 0] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0,168].includes(b)) || (a === 192 && b === 88 && c === 99) || (a === 198 && [18,19].includes(b)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}
export function checkedHttpsEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { reject('VALIDATION_FAILED', '请填写完整的 HTTPS 接口地址。'); }
  if (value.length > 1000 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || !url.hostname.includes('.') || /(^|\.)(localhost|local|internal|home|lan)$/i.test(url.hostname) || (isIP(url.hostname) && !publicAddress(url.hostname)) || url.hostname.includes(':')) reject('VALIDATION_FAILED', '接口必须是公网 HTTPS 地址，使用443端口，不含账号、查询参数或片段。');
  return url;
}
export function normalizeProviderBaseUrl(value: unknown, protocol: AiProviderProtocol): string {
  if (typeof value !== 'string' || value !== value.trim()) reject('VALIDATION_FAILED', '请填写无首尾空格的 HTTPS 接口地址。');
  const url = checkedHttpsEndpoint(value);
  const endings: Record<AiProviderProtocol, RegExp> = { 'openai-chat': /\/chat\/completions\/?$/, 'openai-responses': /\/responses\/?$/, anthropic: /\/messages\/?$/, gemini: /\/models\/[^/]+:generateContent\/?$/ };
  url.pathname = url.pathname.replace(endings[protocol], '').replace(/\/+$/, '') || '/';
  return url.href.replace(/\/$/, '');
}
export function providerEndpoint(protocol: AiProviderProtocol, baseUrl: string, model: string): string {
  checkedProtocol(protocol); checkedModel(model);
  const base = normalizeProviderBaseUrl(baseUrl, protocol);
  const path = protocol === 'openai-chat' ? '/chat/completions' : protocol === 'openai-responses' ? '/responses' : protocol === 'anthropic' ? '/messages' : `/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`;
  return checkedHttpsEndpoint(base + path).href;
}
