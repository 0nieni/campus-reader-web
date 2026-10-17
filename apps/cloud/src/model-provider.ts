import https from 'https'
import { lookup } from 'dns/promises'
import { isIP } from 'net'
import { reject as problem } from './errors'

export const PROVIDERS = {
  deepseek: { endpoint: 'https://api.deepseek.com/chat/completions', name: 'DeepSeek' },
  openai: { endpoint: 'https://api.openai.com/v1/chat/completions', name: 'OpenAI' },
} as const
export interface Connection { provider: keyof typeof PROVIDERS; model: string; apiKey: string; endpoint?: string }
export function validateConnection(c: Connection) {
  const provider = c && Object.prototype.hasOwnProperty.call(PROVIDERS, c.provider) ? PROVIDERS[c.provider] : undefined
  if (!provider || (c.endpoint && c.endpoint !== provider.endpoint)) problem('UNSUPPORTED_PROVIDER', '请选择支持的服务商；只允许界面所列官方 HTTPS 地址。')
  if (!/^[a-zA-Z0-9_.:/-]{1,100}$/.test(c.model ?? '')) problem('MODEL_INVALID', '请填写服务商提供的模型 ID。')
  if (!c.apiKey || c.apiKey.length > 512 || /[\r\n\s]/.test(c.apiKey)) problem('KEY_INVALID', '请重新输入本次会话的 API Key。')
  return provider
}
export function publicAddress(address: string): boolean {
  // Pin IPv4 only: reject all special, loopback, private, link-local and multicast ranges.
  if (isIP(address) !== 4) return false
  const [a = 0, b = 0, third = 0] = address.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 192 && b === 88 && third === 99) || (a === 198 && [18, 19].includes(b)) || (a === 198 && b === 51 && third === 100) || (a === 203 && b === 0 && third === 113))
}
/** Credentials are used only by this call. Errors never include raw provider bodies, headers or key. */
export async function userCompletion(c: Connection, guide: string, content: string, maxTokens = 1800, officialEndpoint?: string): Promise<string> {
  const provider = validateConnection(c); const target = new URL(officialEndpoint || provider.endpoint)
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) problem('MODEL_NOT_CONFIGURED', '官方模型地址必须是无凭据的 HTTPS 接口。')
  if (guide.length + content.length > 22000) problem('CONTEXT_TOO_LONG', '本批资料过长，请减少选中文章。')
  let timer: ReturnType<typeof setTimeout> | undefined
  const addresses = await Promise.race([
    lookup(target.hostname, { family: 4, all: true }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('服务商域名解析超时，请稍后重试。'), { code: 'CONNECTION_FAILED' })), 4000) }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) problem('CONNECTION_FAILED', '服务商地址解析异常，已停止连接。')
  const pinned = addresses[0]!
  // DeepSeek defaults to thinking. Reading batches need the final text within their output budget.
  // Keep this vendor extension off other OpenAI-compatible endpoints.
  const thinking = target.hostname === 'api.deepseek.com' ? { type: 'disabled' } : undefined
  const payload = Buffer.from(JSON.stringify({ model: c.model, stream: false, thinking, store: c.provider === 'openai' ? false : undefined, max_completion_tokens: c.provider === 'openai' ? maxTokens : undefined, max_tokens: c.provider === 'deepseek' ? maxTokens : undefined, messages: [{ role: 'system', content: guide }, { role: 'user', content }] }))
  if (payload.length > 120000) problem('INPUT_TOO_LONG', '请求超过大小限制，请缩小资料范围。')
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, text?: string) => { if (settled) return; settled = true; clearTimeout(deadline); if (error) reject(error); else resolve(text!) }
    const error = (code: string, message: string) => Object.assign(new Error(message), { code })
    const request = https.request(target, { method: 'POST', agent: false, lookup: ((_host: string, options: { all?: boolean }, cb: any) => options?.all ? cb(null, [{ address: pinned.address, family: 4 }]) : cb(null, pinned.address, 4)) as any, headers: { 'content-type': 'application/json', 'content-length': payload.length, authorization: `Bearer ${c.apiKey}` } }, response => {
      const status = response.statusCode ?? 0
      // Never follow a Location header, including redirects to another official host.
      if (status < 200 || status >= 300) {
        response.resume()
        const code = status === 401 || status === 403 ? 'KEY_REJECTED' : status === 402 ? 'BALANCE_REQUIRED' : status === 429 ? 'PROVIDER_LIMIT' : status === 400 ? 'MODEL_OR_CONTEXT_INVALID' : status === 404 ? 'MODEL_UNSUPPORTED' : 'PROVIDER_ERROR'
        finish(error(code, `服务商返回 HTTP ${status}。请检查 Key、模型、余额、上下文长度或限频；不会改用官方 AI。`)); return
      }
      const chunks: Buffer[] = []; let size = 0
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 256000) { finish(error('RESPONSE_TOO_LARGE', '服务商响应过大，已停止读取。')); request.destroy() } else chunks.push(chunk) })
      response.on('error', () => finish(error('MODEL_UNCERTAIN', '响应中断，服务商处理状态不明。请查看任务状态，不要重复提交。')))
      response.on('end', () => {
        if (settled) return
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const choice = value.choices?.[0]; const text = choice?.message?.content
          if (choice?.finish_reason !== 'stop') return finish(error('OUTPUT_TRUNCATED', '模型本批未完整结束；请缩小资料范围或检查模型配置。'))
          if (typeof text !== 'string' || !text.trim()) return finish(error('MODEL_FORMAT_INVALID', '服务商未返回可阅读的文本，请检查模型是否支持 Chat Completions。'))
          finish(undefined, text.trim())
        } catch { finish(error('MODEL_FORMAT_INVALID', '服务商返回格式无法解析。')) }
      })
    })
    const deadline = setTimeout(() => { finish(error('MODEL_UNCERTAIN', '模型连接超时，服务商处理状态不明。已暂停该批，避免自动重复调用。')); request.destroy() }, 28000)
    request.on('error', () => finish(error('MODEL_UNCERTAIN', '模型连接失败，处理状态不明；请检查网络和任务状态。')))
    request.end(payload)
  })
}
