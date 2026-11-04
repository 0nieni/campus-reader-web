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

/** The program searches this turn directly; model-authored words are never sent. */
export function automaticSearchQuery(question: string, schoolName: string): string | null {
  if (!webSearchAllowed(question)) return null;
  const topic = question.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  const otherSchools = /(?:其他|别的|各个|所有|全国|全球|全世界)(?:的)?学校|外校|校外/.test(topic);
  const campus = /本校|我校|学校|校内/.test(topic) && !otherSchools;
  const school = schoolName.trim();
  const query = campus && school && !topic.includes(school) ? `${school} ${topic}` : topic;
  return topic ? Array.from(query).slice(0, 128).join('') : null;
}
