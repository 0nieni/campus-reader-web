import { isIP } from 'node:net';

export interface SearchCandidate { url: string; title: string; snippet: string }
interface SearchResult { state: 'unconfigured' | 'complete' | 'failed'; message: string; candidates: SearchCandidate[] }
type SearchSchool = { id: string; name: string; homepage?: string; announcementUrl?: string };
const endpoint = 'https://api.tavily.com/search';
const maxBytes = 512 * 1024;
const failed = (): SearchResult => ({ state: 'failed', message: '本次联网搜索未完成，已有公告仍可使用。', candidates: [] });

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
export async function searchAnnouncements(school: SearchSchool, query: string, options: { fetch?: typeof fetch; apiKey?: string; scope?: 'school' | 'web' } = {}): Promise<SearchResult> {
  const apiKey = (options.apiKey ?? process.env.TAVILY_API_KEY ?? '').trim();
  if (!apiKey) return { state: 'unconfigured', message: '联网搜索未配置，继续使用已有公告。', candidates: [] };
  const domains = [...new Set([school.homepage, school.announcementUrl].flatMap(value => {
    const url = value && safeUrl(value);
    if (!url) return [];
    // A trusted university entry anchors its Chinese institutional domain;
    // do not generalize this to arbitrary public suffixes such as .com/.cn.
    const host = url.hostname;
    return [host.endsWith('.edu.cn') ? host.split('.').slice(-3).join('.') : host];
  }))];
  const web = options.scope === 'web';
  if (!web && !domains.length) return failed();
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
          query: (web ? query.trim().replace(/本校|我们学校/g, school.name.trim()) : `${school.name.trim()} ${query.trim()}`).slice(0, 500),
          ...(!web ? { include_domains: domains, include_domains_mode: 'restrict' } : {}), search_depth: 'basic', topic: 'general',
          max_results: 5, auto_parameters: false, include_answer: false, include_raw_content: false,
        }),
      });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return failed(); }
      const data = await limitedJson(response, controller.signal);
      if (!data || typeof data !== 'object' || !('results' in data) || !Array.isArray(data.results)) return failed();
      const candidates: SearchCandidate[] = [], seen = new Set<string>();
      for (const item of data.results) {
        if (!item || typeof item !== 'object' || typeof item.url !== 'string' || typeof item.title !== 'string' || !item.title.trim()) continue;
        const url = safeUrl(item.url);
        if (!url || (!web && !domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) || seen.has(url.href)) continue;
        seen.add(url.href);
        candidates.push({ url: url.href, title: item.title.trim().slice(0, 220), snippet: typeof item.content === 'string' ? item.content.trim().slice(0, 2000) : '' });
        if (candidates.length === 5) break;
      }
      return { state: 'complete', message: '本次联网搜索已完成，搜索摘要仅供发现线索，正文仍需核验。', candidates };
    })()]);
  } catch { return failed(); }
  finally { clearTimeout(timer); }
}

export const searchPublicWeb = (school: SearchSchool, query: string, options: { fetch?: typeof fetch; apiKey?: string } = {}) =>
  searchAnnouncements(school, query, { ...options, scope: 'web' });
