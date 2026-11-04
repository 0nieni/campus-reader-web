import { randomUUID } from 'node:crypto'
import { AppError, reject } from './errors'
import { userCompletion, validateConnection, PROVIDERS, type Connection } from './model-provider'
import { signedRelay, type RelayRequest, type RelayBatch } from './relay-protocol'
import type { GatewayResult, ReadingTask, GatewayActions } from '@campus/contracts'

type Environment = (name: string) => string | undefined
type Options = { env: Environment; fetch?: typeof fetch; complete?: typeof userCompletion; now?: () => number }
type Status = GatewayActions['ai.status']['output']
type BrokerValue = ReadingTask | RelayBatch | Status
const providerErrors = new Set(['KEY_REJECTED', 'BALANCE_REQUIRED', 'PROVIDER_LIMIT', 'MODEL_OR_CONTEXT_INVALID', 'MODEL_UNSUPPORTED', 'OUTPUT_TRUNCATED', 'PROVIDER_CONTENT_FILTER', 'PROVIDER_INTERRUPTED', 'MODEL_FORMAT_INVALID', 'CONTEXT_TOO_LONG', 'RESPONSE_TOO_LARGE'])
async function boundedText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return ''
  const reader = body.getReader(), chunks: Uint8Array[] = []; let length = 0
  try {
    while (true) {
      const value = await reader.read(); if (value.done) break
      length += value.value.length
      if (length > limit) { await reader.cancel(); reject('PAYLOAD_TOO_LARGE', 'AI 请求或响应超过大小限制。') }
      chunks.push(value.value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })

/** No database credentials or model keys are accepted from URL parameters. No automatic retries. */
export function createRelayHandler(options: Options) {
  const fetcher = options.fetch || fetch, completion = options.complete || userCompletion, now = options.now || Date.now
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'POST') return json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: '此入口仅接受 POST 请求。' }, 405)
      const origin = request.headers.get('origin')
      if (origin && origin !== new URL(request.url).origin) return json({ ok: false, code: 'FORBIDDEN', message: '请从同一 Netlify 网页使用 AI。' }, 403)
      const authorization = request.headers.get('authorization') || ''
      if (!/^Bearer [^\s]{16,8192}$/.test(authorization)) return json({ ok: false, code: 'UNAUTHENTICATED', message: '请先登录本人工作区。' }, 401)
      if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) reject('VALIDATION_FAILED', '请发送 JSON 请求。')
      const secret = options.env('AI_RELAY_SECRET')
      if (!secret || secret.length < 32 || secret.length > 256) return json({ ok: false, code: 'RELAY_NOT_CONFIGURED', message: 'Netlify 尚未配置 AI_RELAY_SECRET。' }, 503)
      const envId = options.env('CLOUDBASE_ENV_ID') || 'cloudbase-d3gw62aemba0c819e'
      const functionName = options.env('CLOUDBASE_AI_FUNCTION') || 'webAi'
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(envId) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,59}$/.test(functionName)) reject('RELAY_NOT_CONFIGURED', 'Netlify 云环境配置无效。')
      let input: { action: string; input: { taskId?: string; step?: number; connection?: Connection } }
      try { input = JSON.parse(await boundedText(request.body, 12000)) } catch (error) { if (error instanceof AppError) throw error; reject('VALIDATION_FAILED', 'AI 请求格式无效。') }
      if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['action', 'input'].includes(key)) || !['ai.step', 'ai.status'].includes(input.action) || !input.input || typeof input.input !== 'object' || Array.isArray(input.input)) reject('VALIDATION_FAILED', 'AI 请求参数无效。')
      const checking = input.action === 'ai.status'
      if (checking ? Object.keys(input.input).length > 0 : Object.keys(input.input).some(key => !['taskId', 'step', 'connection'].includes(key)) || typeof input.input.taskId !== 'string' || !/^[a-zA-Z0-9_-]{12,200}$/.test(input.input.taskId) || !Number.isInteger(input.input.step) || input.input.step! < 0) reject('VALIDATION_FAILED', '只允许读取额度或执行当前阅读任务的指定批次。')
      const connection = input.input.connection
      if (connection) {
        if (typeof connection !== 'object' || Array.isArray(connection) || Object.keys(connection).some(key => !['provider', 'model', 'apiKey'].includes(key))) reject('KEY_INVALID', 'API 连接无效。')
        validateConnection(connection)
      }
      // Configuration failures must happen before CloudBase claims the batch.
      const officialKey = options.env('AI_CHAT_API_KEY')
      const hasOfficialKey = Boolean(officialKey && officialKey.length <= 512 && !/\s/.test(officialKey))
      if (!checking && !connection && !hasOfficialKey) return json({ ok: false, code: 'MODEL_NOT_CONFIGURED', message: '请在 Netlify 的 Functions 环境变量中填写 DeepSeek API Key 并重新部署。' }, 503)
      const leaseId = randomUUID(), taskId = checking ? 'relay_status_probe' : input.input.taskId!, step = checking ? 0 : input.input.step!
      async function broker(phase: RelayRequest['phase'], extra: Partial<RelayRequest> = {}): Promise<BrokerValue> {
        const body = signedRelay({ phase, taskId, step, leaseId, timestamp: now(), ...extra }, secret!)
        const response = await fetcher(`https://${envId}.api.tcloudbasegateway.com/v1/functions/${functionName}`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
          headers: { authorization, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ action: 'ai.relay', input: body }),
        })
        // Only the fixed authenticated CloudBase endpoint receives the session token.
        let value: any
        try { value = JSON.parse(await boundedText(response.body, 160000)) } catch { reject('RELAY_RESPONSE_INVALID', '云端未返回可验证的批次状态，请刷新任务，勿重复提交。') }
        if (value && typeof value === 'object' && !('ok' in value) && value.result && typeof value.result === 'object') value = value.result
        if (value && typeof value === 'object' && !('ok' in value) && typeof value.data?.response_data === 'string') {
          try { value = JSON.parse(value.data.response_data) } catch { reject('RELAY_RESPONSE_INVALID', '云端批次状态格式无效。') }
        }
        if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') {
          if ([401, 403].includes(response.status)) reject('UNAUTHENTICATED', 'AI 会话验证失败，请重新登录。')
          reject('RELAY_RESPONSE_INVALID', '云端未返回可验证的批次状态，请刷新任务，勿重复提交。')
        }
        const envelope = value as GatewayResult<BrokerValue>
        if (!envelope.ok) {
          const code = /^[A-Z_]{1,64}$/.test(envelope.code) ? envelope.code : 'AI_CONNECTION_FAILED'
          const messages: Record<string, string> = { UNAUTHENTICATED: '当前登录无效，请重新登录。', FORBIDDEN: '当前账号没有工作区权限。', RELAY_FORBIDDEN: 'AI 执行验证失败，请核对两端的执行密钥并刷新任务。', RELAY_NOT_CONFIGURED: '请在 webAi 配置执行密钥和 AI_EXECUTION_MODE=netlify。', TASK_BUSY: '已有一批正在处理，请刷新任务状态，勿重复提交。', RESULT_EXPIRED: '阅读任务已到期，请重新选择公告。', MATERIAL_CHANGED: '资料或处理权限已变化，请重新预览。', MODEL_NOT_CONFIGURED: '官方模型配置已变化或缺失，请核对两端服务端配置。' }
          reject(code, messages[code] || '云端未完成本次操作，请刷新任务状态；不会自动重发模型请求。')
        }
        if (!response.ok) reject('RELAY_RESPONSE_INVALID', '云端执行返回异常，请刷新任务状态。')
        const data = envelope.data
        if (!data || typeof data !== 'object') reject('RELAY_RESPONSE_INVALID', '云端未返回当前阅读任务的状态。')
        if (phase === 'check') {
          if (!('quota' in data) || typeof data.officialConfigured !== 'boolean' || !data.quota || !(typeof data.quota.remaining === 'number' || data.quota.remaining === null && data.quota.limit === null)) reject('RELAY_RESPONSE_INVALID', '云端未返回有效的额度状态。')
        } else if (!('kind' in data)) {
          if (!('id' in data) || data.id !== taskId || !Number.isInteger(data.step) || !['ready', 'running', 'complete', 'failed', 'uncertain', 'cancelled'].includes(data.state)) reject('RELAY_RESPONSE_INVALID', '云端未返回当前阅读任务的状态。')
        }
        return envelope.data
      }
      if (checking) {
        const status = await broker('check') as Status
        return json({ ok: true, data: { ...status, officialConfigured: status.officialConfigured && hasOfficialKey } })
      }
      const batch = await broker('prepare', connection ? { connection: { provider: connection.provider, model: connection.model, apiKey: 'validated-by-relay' } } : {})
      if (!batch || !('kind' in batch) || batch.kind !== 'batch') return json({ ok: true, data: batch })
      const descriptor = batch as RelayBatch
      // Never allow a cloud configuration to route a provider key to another host.
      const endpoint = descriptor.endpoint || PROVIDERS[descriptor.provider]?.endpoint
      const allowed = [PROVIDERS.deepseek.endpoint, 'https://api.deepseek.com/v1/chat/completions', PROVIDERS.openai.endpoint]
      let output: string
      try {
        if (!allowed.includes(endpoint || '') || (descriptor.provider === 'openai' ? !endpoint?.startsWith('https://api.openai.com/') : !endpoint?.startsWith('https://api.deepseek.com/'))) reject('MODEL_UNSUPPORTED', '只允许 DeepSeek 或 OpenAI 官方模型地址。')
        if ((descriptor.service === 'byok') !== Boolean(connection) || (connection && (connection.provider !== descriptor.provider || connection.model !== descriptor.model))) reject('MODEL_UNSUPPORTED', '本次服务商或模型与阅读任务不一致。')
        const actual: Connection = { provider: descriptor.provider, model: descriptor.model, apiKey: connection?.apiKey || officialKey! }
        output = await completion(actual, descriptor.guide, descriptor.content, descriptor.maxTokens, endpoint)
      } catch (error) {
        const raw = (error as { code?: string })?.code
        const errorCode = typeof raw === 'string' && providerErrors.has(raw) ? raw : 'MODEL_UNCERTAIN'
        const task = await broker('fail', { errorCode })
        return json({ ok: true, data: task })
      }
      // Commit failures are never treated as model failures and never repeat the paid request.
      return json({ ok: true, data: await broker('complete', { output }) })
    } catch (error) {
      const appError = error instanceof AppError
      const code = appError ? error.code : 'AI_CONNECTION_FAILED'
      return json({ ok: false, code, message: appError ? error.message : 'AI 请求未完成，请刷新任务状态；不会自动重发模型请求。' }, code === 'UNAUTHENTICATED' ? 401 : code === 'FORBIDDEN' ? 403 : appError ? 400 : 502)
    }
  }
}
