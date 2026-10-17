import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { load } from 'cheerio/slim';
import { publicAddress } from './model-provider';
import { AppError } from './errors';

export interface SchoolSource { id: string; name: string; announcementUrl: string; homepage: string }
export interface SchoolPage { html: string; url: string }
export type PageReader = (url: string, school: SchoolSource) => Promise<SchoolPage>;
const compact = (s: string) => s.replace(/\s+/g, ' ').trim();
const fail = () => new AppError('SOURCE_UNAVAILABLE', '学校公开页面暂时无法读取，可能需要校园网、登录或人工更新入口。');
export function approvedSchoolUrl(value: string, school: SchoolSource): URL {
  const url = new URL(value);
  const hosts = [new URL(school.announcementUrl).hostname, new URL(school.homepage).hostname];
  const allowed = hosts.some(host => url.hostname === host || (host.endsWith('.edu.cn') && (url.hostname === host.split('.').slice(-3).join('.') || url.hostname.endsWith('.' + host.split('.').slice(-3).join('.')))));
  if (!allowed || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.href.length > 1800) throw fail();
  url.hash = ''; return url;
}
/** No cookies, credentials, campus-login bypass or TLS exceptions. Each redirect
 * is checked and every DNS result is validated before pinning a public address. */
export const readSchoolPage: PageReader = async (value, school) => {
  const deadline = Date.now() + 9000;
  async function read(value: string, redirects: number): Promise<SchoolPage> {
    const url = approvedSchoolUrl(value, school);
    if (redirects > 3 || Date.now() >= deadline) throw fail();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      lookup(url.hostname, { family: 4, all: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(fail()), Math.min(2000, deadline - Date.now())); }),
    ]).finally(() => clearTimeout(timer));
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw fail();
    return new Promise<SchoolPage>((resolve, reject) => {
      const finishError = () => reject(fail());
      const req = (url.protocol === 'https:' ? https : http).get(url, {
        agent: false,
        lookup: ((_host: string, options: { all?: boolean }, cb: any) => options?.all ? cb(null, [{ address: addresses[0]!.address, family: 4 }]) : cb(null, addresses[0]!.address, 4)) as any,
        headers: { 'user-agent': 'CampusReader/1.0 (public university notices)', accept: 'text/html,application/xhtml+xml', 'accept-encoding': 'identity' },
      }, res => {
        if ([301,302,303,307,308].includes(res.statusCode || 0) && res.headers.location) {
          res.resume(); read(new URL(res.headers.location, url).href, redirects + 1).then(resolve, reject); return;
        }
        if (res.statusCode !== 200 || !/text\/html|application\/xhtml\+xml/i.test(String(res.headers['content-type'] || ''))) { res.resume(); finishError(); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1500000) { req.destroy(); finishError(); } else chunks.push(chunk); });
        res.on('error', finishError);
        res.on('end', () => {
          try {
            const buffer = Buffer.concat(chunks);
            const head = buffer.subarray(0, 4096).toString('ascii');
            const charset = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(String(res.headers['content-type']) + head)?.[1]?.toLowerCase();
            const html = new TextDecoder(charset && /^(gbk|gb2312|gb18030)$/.test(charset) ? 'gb18030' : 'utf-8').decode(buffer);
            resolve({ html, url: url.href });
          } catch { finishError(); }
        });
      });
      const clock = setTimeout(() => req.destroy(fail()), Math.max(1, deadline - Date.now()));
      req.on('close', () => clearTimeout(clock)); req.on('error', finishError);
    });
  }
  return read(value, 0);
};

export interface ExtractedNotice { id: string; title: string; url: string; publishedAt: string | null }
export function fullDate(text: string): string | null {
  const found = /\b(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})(?:日|\b)/.exec(text);
  if (!found) return null;
  const [,y,m,d] = found;
  return validDate(y!,m!,d!);
}
function validDate(y: string,m: string,d: string) {
  const utc = new Date(Date.UTC(+y,+m-1,+d));
  return utc.getUTCFullYear() === +y && utc.getUTCMonth() === +m-1 && utc.getUTCDate() === +d ? new Date(+utc - 8*3600000).toISOString() : null;
}
export function extractNotices(page: SchoolPage, school: SchoolSource): ExtractedNotice[] {
  const $ = load(page.html); $('script,style,nav,header,footer,noscript').remove();
  if ($('input[type=password]').length || /统一身份认证|用户登录|校园门户登录/.test($('title').text())) throw fail();
  const list: ExtractedNotice[] = [], seen = new Set<string>();
  $('a[href]').each((_, element) => {
    const a = $(element), title = compact(a.attr('title') || a.text());
    if (title.length < 8 || title.length > 220 || /^(首页|上一页|下一页|末页|更多|关于我们|联系我们|用户登录|统一身份)/.test(title)) return;
    if (new URL(page.url).pathname === '/' && !/通知|公告|公示|征集|报名/.test(title) && !/通知公告|信息公告|公示公告/.test(a.closest('section').text().slice(0,300))) return;
    let url: URL; try { url = approvedSchoolUrl(new URL(a.attr('href')!,page.url).href,school); } catch { return; }
    if (/\.(pdf|docx?|xlsx?|zip|rar|png|jpg)(?:$|\?)/i.test(url.href) || seen.has(url.href) || url.href === page.url) return;
    // Accept article-shaped URLs only: never turn homepage/navigation labels into notices.
    if (!(/\/info\/\d+\/\d+\.(?:s?html?|jhtml)/i.test(url.pathname) || /\/(?:\d{4,}|[a-f0-9-]{16,})\.(?:s?html?|jhtml)$/i.test(url.pathname) || /\/20\d{2}\/\d{4}\/[^/]+\/page\.htm/i.test(url.pathname) || /\/(?:page|article|content|detail|node)\//i.test(url.pathname) || /(?:article|news|content|info)id=\d+/i.test(url.search))) return;
    const container = a.closest('li,tr,.news-item,.list-item');
    const dateText = container.find('time').attr('datetime') || container.find('time,.date,.time,.news-time,.publish-time,.Article_PublishDate').first().text() || container.clone().find('a').remove().end().text();
    const publishedAt = fullDate(compact(dateText));
    seen.add(url.href);
    list.push({ id: 'notice_' + createHash('sha256').update(school.id + '\n' + url.href).digest('hex'), title, url: url.href, publishedAt });
  });
  return list.slice(0,30);
}
export function extractArticle(page: SchoolPage): string {
  const $ = load(page.html); $('script,style,nav,header,footer,noscript,form').remove();
  const content = $('#vsb_content_2,#vsb_content,.v_news_content,.wp_articlecontent,.TRS_Editor,.article-content,.article_content,.news_content,.content-detail,.pageArticle .article,article').first();
  if (!content.length) throw new AppError('NO_MATERIAL','此公告正文需要人工核验，请先查看原文；暂不能发送 AI。');
  content.find('br').replaceWith('\n'); content.find('p,div,li,h1,h2,h3,table').append('\n');
  const text = content.text().split(/\n+/).map(compact).filter(Boolean).join('\n');
  if (text.length < 30 || text.length > 60000 || /请输入密码|统一身份认证登录/.test(text)) throw fail();
  return text;
}
