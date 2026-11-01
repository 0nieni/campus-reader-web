import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { load } from 'cheerio/slim';
import { publicAddress } from './model-provider';
import { AppError } from './errors';

export interface SchoolSource { id: string; name: string; announcementUrl: string; homepage: string; listSelector?: string; articleSelector?: string; dateSelector?:string; exactHost?:boolean; allowedPath?:(url:string)=>boolean; rawResponse?:boolean }
export interface SchoolPage { html: string; url: string }
export type PageReader = (url: string, school: SchoolSource) => Promise<SchoolPage>;
const compact = (s: string) => s.replace(/\s+/g, ' ').trim();
const fail = () => new AppError('SOURCE_UNAVAILABLE', '学校公开页面暂时无法读取，可能需要校园网、登录或人工更新入口。');
export const PARSER_VERSION = 'school-pages-v2';
export function approvedSchoolUrl(value: string, school: SchoolSource): URL {
  const url = new URL(value);
  if (/^(?:webvpn|vpn|sso|cas|auth)\./i.test(url.hostname)) throw new AppError('SOURCE_LOGIN_REQUIRED','此链接为学校登录或VPN入口，未采集受限内容。');
  const hosts = [new URL(school.announcementUrl).hostname, new URL(school.homepage).hostname];
  const allowed = hosts.some(host => url.hostname === host || (!school.exactHost && host.endsWith('.edu.cn') && (url.hostname === host.split('.').slice(-3).join('.') || url.hostname.endsWith('.' + host.split('.').slice(-3).join('.')))));
  if (!allowed || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || /[{}]|%7b|%7d/i.test(url.href) || url.href.length > 1800) throw fail();
  if(school.allowedPath&&!school.allowedPath(url.href))throw new AppError('SOURCE_ROBOTS_BLOCKED','该路径不允许自动采集，请使用原站。');
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
        headers: { 'user-agent': 'CampusReader/1.0 (public university notices)', accept: 'text/html,application/xhtml+xml,application/xml,text/xml,application/json,application/rss+xml,application/atom+xml', 'accept-encoding': 'identity' },
      }, res => {
        if ([301,302,303,307,308].includes(res.statusCode || 0) && res.headers.location) {
          res.resume(); read(new URL(res.headers.location, url).href, redirects + 1).then(resolve, reject); return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new AppError(res.statusCode===404?'SOURCE_NOT_FOUND':[401,403].includes(res.statusCode||0)?'SOURCE_RESTRICTED':'SOURCE_UNAVAILABLE',res.statusCode===404?'学校公告栏目已调整或不存在。':[401,403].includes(res.statusCode||0)?'学校网站拒绝公开访问，请使用原站允许的访问方式。':'学校源站暂时不可用，请稍后重试。'));return;
        }
        if (!/text\/(?:html|xml)|application\/(?:xhtml\+xml|xml|json|rss\+xml|atom\+xml)/i.test(String(res.headers['content-type'] || '')) && !(url.pathname==='/robots.txt' && /text\/plain/i.test(String(res.headers['content-type']||'')))) { res.resume(); finishError(); return; }
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
export const noticeId = (schoolId:string,url:string) => 'notice_' + createHash('sha256').update(schoolId+'\n'+url).digest('hex');
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
function dateMetadata(value:string):string|null {
  const direct=fullDate(value);if(direct)return direct;
  const split=/(?:^|\s)(\d{1,2})\s+(20\d{2})[-./](\d{1,2})(?:\s|$)/.exec(value);
  if(split)return validDate(split[2]!,split[3]!,split[1]!);
  const ymd=/(?:^|\s)(20\d{2})\s+(\d{1,2})\s+(\d{1,2})(?:\s|$)/.exec(value);
  if(ymd)return validDate(ymd[1]!,ymd[2]!,ymd[3]!);
  const yearMonthDay=/(?:^|\s)(20\d{2})[-./](\d{1,2})\s+(\d{1,2})(?:\s|$)/.exec(value);
  return yearMonthDay?validDate(yearMonthDay[1]!,yearMonthDay[2]!,yearMonthDay[3]!):null;
}
function preparedPage(html:string) {
  const $=load(html);
  // Parse inert fallback markup only; never evaluate site JavaScript.
  $('script[type="text/html"],script[type="text/template"]').each((_,el)=>{const text=$(el).text();if(text.length<150000 && !/\{\{|<%/.test(text))$(el).replaceWith(text);});
  if ($('input[type=password]').length || /身份认证|身份服务系统|统一登录|单点登录|用户登录|校园门户登录|融合门户/.test($('title').text())) throw new AppError('SOURCE_LOGIN_REQUIRED','此入口需要学校账号登录，未采集校内受限内容。');
  if (/\/dynamic_challenge|cf-chl-/.test($('script').text()) || /^系统提示\s*$/.test($('title').text().trim())) throw new AppError('SOURCE_RESTRICTED','学校网站有访问验证，暂不自动读取此入口。');
  $('script,style,nav,header,footer,noscript,[role="navigation"],.header,.footer,.navbar,#navbar,#header,#footer,#nav,.nav,.navBox,.navList,.mobile-inner-nav,.pop-ph-nav,.g-nav,.g-nav2,.menu,.menu-item,.sub-item,.wp-navi,[id^="wp_nav_"],.gp-nav,.gp-m-subNav').remove();return $;
}
export function articleShapedUrl(url:URL):boolean {
  return /\/info\/\d+\/\d+\.(?:s?html?|jhtml)/i.test(url.pathname)
    || /\/(?:[it]?\d{4,}|t\d{8}_\d+|[a-f0-9-]{16,})\.(?:s?html?|jhtml)$/i.test(url.pathname)
    || /\/c\d+a\d+\/page\.(?:htm|psp)$/i.test(url.pathname)
    || /\/(?:page|article|content|detail|node)\//i.test(url.pathname)
    || /(?:article|news|content|info|wbnews)id=\d+/i.test(url.search)
    || (/\/(?:[\w-]*(?:detail|article|notice|show|content|view|news)[\w-]*)\.(?:php|jsp|do|html?)$/i.test(url.pathname) && /(?:\?|&)(?:id|aid|articleId|infoId|pkvalue)=[a-z0-9_-]{1,100}(?:&|$)/i.test(url.search));
}
export function extractNotices(page: SchoolPage, school: SchoolSource): ExtractedNotice[] {
  const $ = preparedPage(page.html);
  const list: ExtractedNotice[] = [], seen = new Set<string>();
  (school.listSelector ? $(school.listSelector).find('a[href]') : $('a[href]')).each((_, element) => {
    const a = $(element);
    const heading=a.find('h1,h2,h3,h4,h5,h6,.title,.tit,.news_title,.name').filter((_,el)=>{const text=compact($(el).text());return text.length>=4 && !/^[\d\s./-]+$/.test(text);}).first();
    const titleNode=a.clone();titleNode.find('time,[class*="date"],[class*="time"]').remove();
    const title = compact(a.attr('title') || heading.text() || titleNode.text()).replace(/\s*查看详情\s*$/,'');
    if (title.length < 4 || title.length > 220 || /^(首页|上一页|下一页|末页|更多|关于我们|联系我们|用户登录|统一身份)/.test(title)) return;
    const section=a.parents('section,div').filter((_,el)=>$(el).find('a[href]').length<=60 && $(el).text().length<18000).first();
    const sectionHeading=section.find('h1,h2,h3,h4,.title,.tit').first().text();
    if (new URL(page.url).pathname === '/' && !/通知|公告|公示|征集|报名/.test(title) && !/通知公告|信息公告|公示公告/.test(sectionHeading)) return;
    let url: URL; try { url = approvedSchoolUrl(new URL(a.attr('href')!,page.url).href,school); } catch { return; }
    if (/\.(pdf|docx?|xlsx?|zip|rar|png|jpg)(?:$|\?)/i.test(url.href) || seen.has(url.href) || url.href === page.url) return;
    // Accept article-shaped URLs only: never turn homepage/navigation labels into notices.
    if (!articleShapedUrl(url)) return;
    const closest = a.closest('li,tr,.news-item,.list-item,.item,.news,.notice_item,.column-news-item');
    const nearby=a.parents('div').filter((_,el)=>$(el).find('a').length<=3 && $(el).text().length<1000 && $(el).find('time,[class*="date"],[class*="time"]').length>0).first();
    const container = closest.length ? closest : nearby.length ? nearby : a.parent();
    const metaText=(element:ReturnType<typeof $>)=>{const clone=element.clone();clone.find('*').append(' ');return compact(clone.text());};
    const smallDate=container.find('span,i,em').filter((_,el)=>{
      const node=$(el),text=metaText(node);
      if(node.closest('h1,h2,h3,h4,h5,h6,.title,.tit,.news_title,.name,.bt').length)return false;
      // A date-shaped span inside an otherwise unstructured title may be a
      // deadline. Only accept an independent field, or a sibling of a heading.
      return (!node.closest('a').length || heading.length>0 || el.tagName==='i') && text.length<=12 && !!dateMetadata(text);
    }).first();
    const dated=container.find(school.dateSelector || 'time,[class*="date"],[class*="time"],.Article_PublishDate,.sj,dl').first();
    const precedingDate=school.dateSelector?container.prev(school.dateSelector):$('__no_date__');
    const dateText = container.find('time').attr('datetime') || (dated.length?metaText(dated):'') || (smallDate.length?metaText(smallDate):'') || (precedingDate.length?metaText(precedingDate):'') || metaText(container.clone().find('a,p').remove().end());
    const publishedAt = dateMetadata(compact(dateText));
    seen.add(url.href);
    list.push({ id: noticeId(school.id,url.href), title, url: url.href, publishedAt });
  });
  return list.slice(0,30);
}
export function extractArticle(page: SchoolPage, school?: SchoolSource): string {
  const $ = preparedPage(page.html);
  // VSB wraps public articles in an inert form. Removing that form also removes
  // the entire article; remove controls and retain the public content instead.
  $('input,button,select,textarea').remove();
  const selectors = [school?.articleSelector,'.v_news_content','.wp_articlecontent','#vsb_content_2','#vsb_content','.TRS_Editor','.article-content','.article_content','.news_content','.content-detail','.pageArticle .article','#articleContent','.Article_Content','.article_con','.content-text','.pages_content','.con_txt','article'].filter(Boolean) as string[];
  let content = $('__no_content__');
  for (const selector of selectors) { content=$(selector).filter((_,el)=>$(el).text().trim().length>=30).first();if(content.length)break; }
  if (!content.length) throw new AppError('NO_MATERIAL','此公告正文需要人工核验，请先查看原文；暂不能发送 AI。');
  content.find('br').replaceWith('\n'); content.find('p,div,li,h1,h2,h3,table').append('\n');
  const text = content.text().split(/\n+/).map(compact).filter(Boolean).join('\n');
  if (text.length < 30 || text.length > 60000 || /请输入密码|统一身份认证登录/.test(text)) throw fail();
  return text;
}
/** Article pages can place a column heading before the actual headline. */
export function extractArticleTitle(page:SchoolPage,selector?:string):string {
  const $=preparedPage(page.html);
  const column=/^(?:研究生招生|本科生招生|招生就业|本科生教育|研究生教育|人才培养|通知公告|通知通告|学院概况|首页)$/;
  const valid=(value:string)=>value.length>=4&&value.length<=220&&!column.test(value);
  const candidates=[selector?$(selector).first().text():'', $('meta[name="ArticleTitle"]').attr('content')||'', $('meta[property="og:title"]').attr('content')||'', $('.article-title,.article_title,.news-title,.news_title,.content-title,.arc-title').first().text(),$('title').text(),...$('h1,h2,h3').toArray().map(el=>$(el).text())];
  for(const candidate of candidates){const title=compact(candidate);if(valid(title))return title;}
  throw new AppError('SOURCE_PARSE_FAILED','未能核实此公告的具体标题，请查看原文。');
}
