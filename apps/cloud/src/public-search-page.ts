import { AppError } from './errors';
import { approvedSchoolUrl, readSchoolPage, type PageReader, type SchoolPage, type SchoolSource } from './school-pages';
import { robotsAllowed, websiteUrl } from './website-parser';

export function publicSearchSource(value: string): SchoolSource {
  const url = new URL(websiteUrl(value));
  if (url.protocol !== 'https:' || /^(?:login|metadata)\./i.test(url.hostname)) throw new AppError('SOURCE_RESTRICTED', '只能读取无需登录的 HTTPS 公开网页。');
  return { id: 'public-search', name: url.hostname, homepage: url.origin + '/', announcementUrl: url.href, exactHost: true,
    articleSelector: 'main, [role="main"], .markdown-body, #content' };
}

/** Reuse the pinned-public-DNS reader, exact-host redirects and bounded parser.
 * No login credentials or cookies are sent. Robots failures remain unreadable. */
export async function readPublicSearchPage(value: string, reader: PageReader = readSchoolPage, pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<SchoolPage> {
  const source = publicSearchSource(value), url = approvedSchoolUrl(value, source);
  let rules = '';
  try { rules = (await reader(url.origin + '/robots.txt', source)).html; }
  catch (error) { if (!(error instanceof AppError) || error.code !== 'SOURCE_NOT_FOUND') throw error; }
  if (rules.length > 100000 || [...rules.matchAll(/^\s*crawl-delay\s*:\s*([\d.]+)/gim)].some(match => Number(match[1]) > 1.5))
    throw new AppError('SOURCE_ROBOTS_BLOCKED', '该网站的采集规则暂不支持自动读取，请查看原文。');
  source.allowedPath = target => robotsAllowed(rules, target);
  if (!source.allowedPath(url.href)) throw new AppError('SOURCE_ROBOTS_BLOCKED', '该网页不允许自动读取，请查看原文。');
  await pause(1500);
  const page = await reader(url.href, source);
  publicSearchSource(page.url);
  approvedSchoolUrl(page.url, source);
  return page;
}

const hostReads = new Map<string, Promise<SchoolPage>>();
export const publicSearchReader: PageReader = async value => {
  const host = new URL(publicSearchSource(value).homepage).host;
  const previous = hostReads.get(host);
  const pending = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => readPublicSearchPage(value));
  hostReads.set(host, pending);
  try { return await pending; }
  finally { if (hostReads.get(host) === pending) hostReads.delete(host); }
};
