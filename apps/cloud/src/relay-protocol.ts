import { createHmac, timingSafeEqual } from 'node:crypto'
import { reject } from './errors'

export interface RelayRequest {
  phase: 'check' | 'prepare' | 'complete' | 'fail'; taskId: string; step: number; leaseId: string; timestamp: number;
  connection?: { provider: string; model: string; apiKey: string }; output?: string; errorCode?: string;
}
export interface RelayBatch {
  kind: 'batch'; service: 'official' | 'byok'; provider: 'deepseek' | 'openai'; model: string;
  endpoint?: string; guide: string; content: string; maxTokens: number;
}
export function relaySignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update('campus-ai-relay-v1\n').update(payload).digest('hex')
}
export function signedRelay(value: RelayRequest, secret: string) {
  const payload = JSON.stringify(value)
  return { payload, signature: relaySignature(payload, secret) }
}
export function verifiedRelay(input: Record<string, unknown>, secret: string | undefined, now = Date.now()): RelayRequest {
  if (!secret || secret.length < 32 || secret.length > 256) reject('RELAY_NOT_CONFIGURED', '请在 webAi 与 Netlify 配置同一份 AI_RELAY_SECRET。')
  if (typeof input.payload !== 'string' || Buffer.byteLength(input.payload) > 100000 || typeof input.signature !== 'string' || !/^[a-f0-9]{64}$/.test(input.signature)) reject('RELAY_FORBIDDEN', 'AI 执行请求验证失败。')
  const expected = relaySignature(input.payload, secret)
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.signature, 'hex'))) reject('RELAY_FORBIDDEN', 'AI 执行请求验证失败。')
  let value: RelayRequest
  try { value = JSON.parse(input.payload) } catch { reject('VALIDATION_FAILED', 'AI 执行请求无效。') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['phase', 'taskId', 'step', 'leaseId', 'timestamp', 'connection', 'output', 'errorCode'].includes(key)) || !['check', 'prepare', 'complete', 'fail'].includes(value.phase) || !/^[a-zA-Z0-9_-]{12,200}$/.test(value.taskId) || !/^[a-zA-Z0-9_-]{12,100}$/.test(value.leaseId) || !Number.isInteger(value.step) || value.step < 0 || !Number.isSafeInteger(value.timestamp) || Math.abs(now - value.timestamp) > 120000) reject('RELAY_FORBIDDEN', 'AI 执行请求无效或已过期。')
  if (value.phase === 'complete' && (typeof value.output !== 'string' || !value.output.trim() || value.output.length > 20000)) reject('VALIDATION_FAILED', '模型结果无效或过长。')
  if (value.phase === 'fail' && (typeof value.errorCode !== 'string' || !/^[A-Z_]{1,64}$/.test(value.errorCode))) reject('VALIDATION_FAILED', '模型错误状态无效。')
  return value
}
