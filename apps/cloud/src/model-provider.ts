import https from 'https'
import { lookup } from 'dns/promises'
import type { AiProviderProtocol } from '@campus/contracts'
import { reject as problem } from './errors'
import { providerHttpCode } from './model-diagnostics'
import { checkedHttpsEndpoint, checkedModel, checkedProtocol, publicAddress } from './provider-endpoints'
import { modelHeaders, modelPayload, modelText, modelUsage } from './model-protocols'
export { publicAddress } from './provider-endpoints'

export const PROVIDERS = {
  deepseek: { endpoint: 'https://api.deepseek.com/chat/completions', name: 'DeepSeek' },
  openai: { endpoint: 'https://api.openai.com/v1/chat/completions', name: 'OpenAI' },
} as const
export interface Connection { provider: keyof typeof PROVIDERS | 'custom'; model: string; apiKey: string; endpoint?: string; protocol?: AiProviderProtocol }
export function validateConnection(c: Connection) {
  const provider = c?.provider === 'custom' && c.endpoint && c.protocol ? { endpoint: checkedHttpsEndpoint(c.endpoint).href, name: '个人服务商' } : c && Object.prototype.hasOwnProperty.call(PROVIDERS, c.provider) ? PROVIDERS[c.provider as keyof typeof PROVIDERS] : undefined
  if (!provider || (c.provider !== 'custom' && c.endpoint && c.endpoint !== provider.endpoint)) problem('UNSUPPORTED_PROVIDER', '请选择支持的服务商或已保存的个人配置。')
  if (c.protocol) checkedProtocol(c.protocol)
  checkedModel(c.model)
  if (!c.apiKey || c.apiKey.length > (c.provider === 'custom' ? 2048 : 512) || /[^\x21-\x7e]/.test(c.apiKey)) problem('KEY_INVALID', '请重新输入有效的 API Key。')
  return provider
}
/** Credentials are used only by this call. Errors never include raw provider bodies, headers or key. */
export interface CompletionResult {text:string;usage?:{inputTokens:number;outputTokens:number;totalTokens:number}}
export async function modelCompletion(c: Connection, guide: string, content: string, maxTokens = 1800, officialEndpoint?: string): Promise<CompletionResult> {
  const provider = validateConnection(c); const target = checkedHttpsEndpoint(officialEndpoint || provider.endpoint)
  const protocol = c.protocol || 'openai-chat'
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
  const payload = Buffer.from(JSON.stringify(modelPayload(protocol, c.model, guide, content, maxTokens, c.provider === 'openai' || target.hostname === 'api.openai.com', target.hostname === 'api.deepseek.com')))
  if (payload.length > 120000) problem('INPUT_TOO_LONG', '请求超过大小限制，请缩小资料范围。')
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, result?: CompletionResult) => { if (settled) return; settled = true; clearTimeout(deadline); if (error) reject(error); else resolve(result!) }
    const error = (code: string, message: string) => Object.assign(new Error(message), { code })
    const request = https.request(target, { method: 'POST', agent: false, lookup: ((_host: string, options: { all?: boolean }, cb: any) => options?.all ? cb(null, [{ address: pinned.address, family: 4 }]) : cb(null, pinned.address, 4)) as any, headers: { 'content-type': 'application/json', 'content-length': payload.length, ...modelHeaders(protocol, c.apiKey) } }, response => {
      const status = response.statusCode ?? 0
      // Never follow a Location header, including redirects to another official host.
      if (status < 200 || status >= 300) {
        const code = providerHttpCode(status)
        finish(error(code, `服务商返回 HTTP ${status}。请检查 Key、模型、余额、上下文长度或限频；不会改用官方 AI。`)); response.destroy(); request.destroy(); return
      }
      const chunks: Buffer[] = []; let size = 0
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 256000) { finish(error('RESPONSE_TOO_LARGE', '服务商响应过大，已停止读取。')); request.destroy() } else chunks.push(chunk) })
      response.on('error', () => finish(error('MODEL_UNCERTAIN', '响应中断，服务商处理状态不明。请查看任务状态，不要重复提交。')))
      response.on('end', () => {
        if (settled) return
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          finish(undefined, {text:modelText(protocol, value),usage:modelUsage(protocol,value)})
        } catch (caught) { finish(caught instanceof Error && 'code' in caught ? caught : error('MODEL_FORMAT_INVALID', '服务商返回格式无法解析。')) }
      })
    })
    const deadline = setTimeout(() => { finish(error('MODEL_UNCERTAIN', '模型连接超时，服务商处理状态不明。已暂停该批，避免自动重复调用。')); request.destroy() }, 28000)
    request.on('error', () => finish(error('MODEL_UNCERTAIN', '模型连接失败，处理状态不明；请检查网络和任务状态。')))
    request.end(payload)
  })
}
/** Existing AI reading and BYOK calls keep the original string interface. */
export async function userCompletion(c:Connection,guide:string,content:string,maxTokens=1800,officialEndpoint?:string):Promise<string>{return(await modelCompletion(c,guide,content,maxTokens,officialEndpoint)).text;}
