import { isIP } from 'node:net';
import type { AiSearchErrorCode } from '@campus/contracts';

export interface SearchCandidate { url: string; title: string; snippet: string }
interface SearchResult { state: 'unconfigured' | 'complete' | 'failed'; code?: AiSearchErrorCode; message: string; candidates: SearchCandidate[] }
type SearchSchool = { id: string; name: string; homepage?: string; announcementUrl?: string };
const endpoint = 'https://api.tavily.com/search';
const maxBytes = 512 * 1024;
const failureMessages: Record<Exclude<AiSearchErrorCode, 'unconfigured'>, string> = {
  authorization: '搜索服务授权异常，请联系网站管理员检查搜索服务凭据。已有公告仍可使用。',
  quota: '搜索服务额度不足，请联系网站管理员检查搜索服务账户。已有公告仍可使用。',
  rate_limited: '搜索服务请求过于频繁，请稍后重试。已有公告仍可使用。',
  timeout: '本次搜索超时，请稍后重试。已有公告仍可使用。',
  network: '搜索服务连接失败，请稍后重试。已有公告仍可使用。',
  provider: '搜索服务暂时异常，请稍后重试。已有公告仍可使用。',
  invalid_response: '搜索服务返回异常，请稍后重试。已有公告仍可使用。',
  invalid_scope: '学校官方域名配置异常，请联系网站管理员检查。已有公告仍可使用。',
};
const failed = (code: Exclude<AiSearchErrorCode, 'unconfigured'>): SearchResult => ({ state: 'failed', code, message: failureMessages[code], candidates: [] });

function safeUrl(value: string): URL | undefined {
  try {
    // URL normalizes an explicit :443 away; inspect the authority first so
    // even default ports and empty userinfo cannot bypass the URL policy.
    const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
    if (!authority || /[:@\\\s]/.test(authority)) return;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(url.hostname.replace(/^\[|\]$/g, ''))
      || !url.hostname.includes('.') || url.hostname.endsWith('.') || /^(?:webvpn|vpn|sso|cas|auth|login)\./i.test(url.hostname)
      || /[{}]|%7b|%7d/i.test(url.href) || url.href.length > 1800) return;
    url.hash = '';
    return url;
  } catch { return; }
}

async function limitedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Search timeout');
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Response exceeds limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Response exceeds limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

/** Search snippets are discovery hints only. Callers must read and re-authorize
 * each candidate through school-pages before treating it as body evidence. */
export async function searchAnnouncements(school: SearchSchool, query: string, options: { fetch?: typeof fetch; apiKey?: string } = {}): Promise<SearchResult> {
  const apiKey = (options.apiKey ?? process.env.TAVILY_API_KEY ?? '').trim();
  if (!apiKey) return { state: 'unconfigured', code: 'unconfigured', message: '联网搜索服务未配置，请联系网站管理员。已有公告仍可使用。', candidates: [] };
  const domains = [...new Set([school.homepage, school.announcementUrl].flatMap(value => {
    const url = value && safeUrl(value);
    if (!url) return [];
    // A trusted university entry anchors its Chinese institutional domain;
    // do not generalize this to arbitrary public suffixes such as .com/.cn.
    const host = url.hostname;
    return [host.endsWith('.edu.cn') ? host.split('.').slice(-3).join('.') : host];
  }))];
  if (!domains.length) return failed('invalid_scope');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Search timeout')); }, 8000);
  });
  try {
    return await Promise.race([timeout, (async (): Promise<SearchResult> => {
      const response = await (options.fetch ?? fetch)(endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          query: `${school.name.trim()} ${query.trim()}`.slice(0, 500),
          include_domains: domains, include_domains_mode: 'restrict', search_depth: 'basic', topic: 'general',
          max_results: 5, auto_parameters: false, include_answer: false, include_raw_content: false,
        }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) return failed('authorization');
        if (response.status === 429) return failed('rate_limited');
        if (response.status === 432 || response.status === 433) return failed('quota');
        return failed('provider');
      }
      let data: unknown;
      try { data = await limitedJson(response, controller.signal); }
      catch { return failed(controller.signal.aborted ? 'timeout' : 'invalid_response'); }
      if (!data || typeof data !== 'object' || !('results' in data) || !Array.isArray(data.results)) return failed('invalid_response');
      const candidates: SearchCandidate[] = [], seen = new Set<string>();
      for (const item of data.results) {
        if (!item || typeof item !== 'object' || typeof item.url !== 'string' || typeof item.title !== 'string' || !item.title.trim()) continue;
        const url = safeUrl(item.url);
        if (!url || !domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain)) || seen.has(url.href)) continue;
        seen.add(url.href);
        candidates.push({ url: url.href, title: item.title.trim().slice(0, 220), snippet: typeof item.content === 'string' ? item.content.trim().slice(0, 2000) : '' });
        if (candidates.length === 5) break;
      }
      return { state: 'complete', message: candidates.length
        ? '本次联网搜索已完成，搜索摘要仅供发现线索，正文仍需核验。'
        : '本次联网搜索已完成，未找到符合本校官方域名范围的公告线索。已有公告仍可使用。', candidates };
    })()]);
  } catch { return failed(controller.signal.aborted ? 'timeout' : 'network'); }
  finally { clearTimeout(timer); }
}
