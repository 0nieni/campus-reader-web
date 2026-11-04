import type { AiRecommendations, RecommendedNotice } from '@campus/contracts';
import type { IdentityContext } from './identity';

export interface ChatWebTools {
  configured(): boolean;
  search(schoolId: string, query: string, identity: IdentityContext): Promise<AiRecommendations>;
  read(schoolId: string, candidate: RecommendedNotice, identity: IdentityContext): Promise<AiRecommendations>;
}

export function webSearchAllowed(question: string): boolean {
  return !/(?:不用|不要|别|无需|不需要|先不|不必|不想|不允许)[^，,。；;！!？?\r\n]{0,12}(?:联网|上网|网络|互联网|网上|搜索|检索|搜|查找|找找)|(?:只|仅)(?:查看|使用|阅读|查询|检索|看|用|读|查|搜)(?:已有|现有|已收录|本地)|\b(?:do not|don't|never|without|no)[^.,;!?\r\n]{0,24}\b(?:browse|browsing|search|web|internet|online)\b|\bstay offline\b/i.test(question);
}

/** Constrain model-authored queries to this question's public topic, not model memory. */
export function publicToolQuery(question: string, query: string, schoolName: string, now = Date.now()): string | null {
  if (!webSearchAllowed(question) || !query.trim() || Array.from(query).length > 128 || /[\x00-\x1f\x7f@]|https?:|\b(?:sk-|tvly-)|\d{7,}|密钥|密码|邮箱|手机号|身份证|秘密|我的|我是|我在/i.test(query)) return null;
  const sensitive = /@|\b(?:sk-|tvly-)|\d{7,}|密钥|密码|邮箱|手机号|身份证|秘密|(?:我的|我在|我是|我就读|我叫|我住)|\bmy\b|\bi(?:'m| am| work| live| study)\b/i;
  const publicText = question.split(/[，,。；;\r\n]/).filter(clause => !sensitive.test(clause)).join(' ');
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/比赛/g, '竞赛');
  const date = new Date(now + 8 * 3600000), year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate();
  // Dates come only from the server clock. Keep Chinese date units attached to
  // their checked numbers, without allowing arbitrary single-character words.
  const dates = new Set([`${year}年`, `${year}年${month}月`, `${year}年${month}月${day}日`, `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`]);
  const allowed = normalize(publicText + ' ' + schoolName + ' 本校 学校 官方 官网 最新 最近 公开 通知 公告 报名 教程 资料 ' + year);
  // Check whole Latin/numeric tokens and contiguous Chinese pairs, rather than
  // accepting arbitrary entities found only in prior conversation or documents.
  const tokens = query.normalize('NFKC').match(/\d{4}年(?:\d{1,2}月(?:\d{1,2}日)?)?|[a-z0-9_+#-]+|[\p{Script=Han}]+|[\p{L}\p{N}\p{M}]+/giu) || [];
  if (!tokens.length || tokens.some(raw => {
    const token = normalize(raw);
    if (dates.has(token)) return false;
    if (/^[a-z0-9_+#-]+$/.test(token)) return !allowed.split(/[^a-z0-9_+#-]+/).includes(token);
    if (!/^[\p{Script=Han}]+$/u.test(token)) return !allowed.includes(token);
    return token.length < 2 || Array.from(token).some((_, index, chars) => index + 1 < chars.length && !allowed.includes(chars[index]! + chars[index + 1]!));
  })) return null;
  // Reconstruct exclusively from checked tokens. Unrecognized punctuation,
  // emoji and invisible characters never ride along in the outbound query.
  return tokens.join(' ');
}
