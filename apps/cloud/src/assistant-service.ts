import type { AiPreferences, AiRecommendations, RecommendedNotice } from '@campus/contracts';
import type { ItemRow, Repository } from './repository';
import type { IdentityContext } from './identity';
import { authorizeSchool, identifier } from './access';
import { atomic, readDoc, seed, transactionRow, type Database } from './storage';
import { assistantProfile } from './assistant-profile';
import { assistantChat } from './assistant-chat';
import { searchAnnouncements } from './announcement-search';
import { approvedSchoolUrl, extractArticle, readSchoolPage, type PageReader } from './school-pages';
import type { aiService } from './ai-service';
import { digest } from './reading-package';
import { AppError, reject } from './errors';
import { isRetained, originalUrl, toNotice } from './gateway';
import { isPrivate, itemVisible, sourceVisible, type Scope } from './scope';
import {reserveSearch} from './search-budget';

function canonicalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}
function publicCandidate(row: ItemRow, scope: Scope, current: number): boolean {
  const expiresAt = (row as ItemRow & { aiSearchExpiresAt?: string }).aiSearchExpiresAt;
  return row.status === 'published' && itemVisible(row, scope) && isRetained(row, new Date(current - 365 * 86400000).toISOString())
    && (!expiresAt || Date.parse(expiresAt) > current)
    && (!isPrivate(row) || row.importKind === 'website') && row.type !== 'manual'
    && !['mail-inbox', 'manual-inbox'].includes(row.key || '') && !/^(mail|manual):/i.test(row.canonicalUrl || '')
    && row.category !== 'mail' && !row.categories?.includes('mail');
}

const actions = new Set(['ai.profile.get','ai.profile.save','ai.profile.clearBehavior','ai.behavior','ai.dismiss','ai.recommend','ai.chat.create','ai.chat.get','ai.chat.send','ai.chat.step','ai.chat.cancel','ai.chat.resolve','ai.chat.clear','ai.chat.latest']);
export function assistantService(db: Database, repo: Repository, ai: ReturnType<typeof aiService>, now = Date.now, search = searchAnnouncements, reader: PageReader = readSchoolPage) {
  const profile = assistantProfile(db, repo, now);
  const chat = assistantChat(db, repo, ai, profile.recommend, now, async (schoolId, query, identity) => {
    try { return await recommendations({ schoolId, query, search: true }, identity); }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'SEARCH_LIMIT') throw error;
      const local = await profile.recommend(identity.dataOwnerId, schoolId, query);
      return { ...local, search: { state: 'failed', message: error.message } };
    }
  });
  async function searchBudget(owner: string) {
    await reserveSearch(db,owner,now());
  }
  async function recommendations(input: Record<string, unknown>, identity: IdentityContext): Promise<AiRecommendations> {
    const owner = identity.dataOwnerId, schoolId = identifier(input.schoolId), school = await authorizeSchool(repo, owner, schoolId);
    if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 500)) reject('VALIDATION_FAILED', '搜索问题最多 500 字。');
    if (input.search !== undefined && typeof input.search !== 'boolean') reject('VALIDATION_FAILED', '联网搜索开关无效。');
    const query = String(input.query || '').trim(), local = await profile.recommend(owner, schoolId, query);
    if (!input.search) return process.env.TAVILY_API_KEY || search !== searchAnnouncements
      ? { ...local, search: { state: 'idle', message: '联网搜索已配置，点击搜索后执行；当前仅展示已有公告。' } } : local;
    if (process.env.TAVILY_API_KEY || search !== searchAnnouncements) await searchBudget(owner);
    const found = await search(school, query || '通知公告 报名');
    const result: AiRecommendations = { ...local, search: { state: found.state, message: found.message } };
    if (found.state !== 'complete') return result;
    const scope = await repo.scope(schoolId, owner), current = now();
    const known = new Map<string, ItemRow[]>(), seen = new Set<string>();
    let lookupSaturated = false;
    // Look beyond the five displayed recommendations, while keeping discovery bounded.
    for (let offset = 0; offset < 200; offset += 100) {
      const page = (await repo.items(scope, offset, 100, new Date(current - 365 * 86400000).toISOString())).slice(0, 100);
      for (const row of page) {
        if (seen.has(row._id) || !publicCandidate(row, scope, current)) continue;
        seen.add(row._id);
        for (const url of new Set([canonicalUrl(originalUrl(row)), canonicalUrl(row.canonicalUrl)].filter((url): url is string => Boolean(url))))
          known.set(url, [...(known.get(url) || []), row]);
      }
      if (page.length < 100) break;
      if (offset + page.length >= 200) lookupSaturated = true;
    }
    async function existingCard(rows: ItemRow[]): Promise<RecommendedNotice | null> {
      const cards: RecommendedNotice[] = [];
      for (const row of rows) {
        if (!publicCandidate(row, scope, now())) continue;
        const ids = [...new Set([row.sourceId, ...(row.sourceIds || [])].filter((id): id is string => Boolean(id)))];
        let allowAi = ids.length > 0 && row.aiProcessing !== 'import_only';
        for (const id of ids) {
          const policy = await readDoc(db, 'sources', id);
          if (!policy || policy.enabled === false || policy.deleted === true || policy.aiProcessing === 'import_only') { allowAi = false; continue; }
          if ((policy.scope || policy.ownerOpenid) ? !sourceVisible(policy, schoolId, owner) : !scope.publicSourceIds.includes(id)) allowAi = false;
          if (isPrivate(policy) && (policy.ownerOpenid !== owner || !policy.schoolIds?.includes(schoolId) || !(policy.importKind === 'website' || policy.type === 'ai_search' && policy.autoCollect === false))) allowAi = false;
          if (isPrivate(row) && (row.aiProcessing !== 'allow' || policy.aiProcessing !== 'allow')) allowAi = false;
        }
        const displayed = repo.personalize ? await repo.personalize(row, owner) : row;
        const checked = [row.updatedAt, row.discoveredAt, row.createdAt].find(value => typeof value === 'string' && Number.isFinite(Date.parse(value)));
        cards.push({ ...toNotice(displayed), originalUrl: originalUrl(row), allowAi, readState: row.contentText?.trim() ? 'body' : 'title_only', checkedAt: checked || null,
          reason: allowAi ? '检索命中已收录公告，沿用原公告与来源权限。' : '沿用已有公告及其来源权限；当前不可用于 AI。' });
      }
      // If duplicate authorized records disagree, do not route around the stricter policy.
      return cards.find(card => !card.allowAi) || cards[0] || null;
    }
    const knownCard = (url: string) => existingCard(known.get(canonicalUrl(url) || '') || []);
    const source = { id: schoolId, name: school.name, homepage: school.homepage || school.announcementUrl || '', announcementUrl: school.announcementUrl || school.homepage || '' };
    const sourceId = 'ai_search_' + digest([owner, schoolId]);
    const checkedAt = new Date(now()).toISOString();
    const candidates = await Promise.all(found.candidates.slice(0, 5).map(async (candidate, index): Promise<RecommendedNotice | null> => {
      let url: string;
      try { url = approvedSchoolUrl(candidate.url, source).href; } catch { return null; }
      const existing = await knownCard(url);
      if (existing) return existing;
      if (!/通知|公告|公示|报名|讲座|竞赛|比赛|活动|奖学金|申请|征集|招募|论坛|学术/.test(candidate.title)) return null;
      const id = 'ai_search_item_' + digest([owner, schoolId, url]);
      const card: RecommendedNotice = { id, title: candidate.title, sourceName: `${school.name}公开页面`, originalUrl: url, publishedAt: null, categories: [/竞赛|比赛/.test(candidate.title) ? 'competition' : /讲座|学术|论坛/.test(candidate.title) ? 'academic' : 'school'], summary: null, reason: '本次联网搜索发现，尚未确认与你的参与资格是否匹配。', readState: 'snippet_only', checkedAt, allowAi: false };
      if (lookupSaturated) return { ...card, reason: '本次已有公告核验范围已满，尚未确认此链接是否对应已有来源；仅展示搜索线索。' };
      if (index >= 3) return card;
      try {
        const page = await reader(url, source);
        const finalUrl = approvedSchoolUrl(page.url, source).href;
        const redirected = await knownCard(finalUrl);
        if (redirected) return redirected;
        const text = extractArticle(page, source);
        await authorizeSchool(repo, owner, schoolId);
        const existingSource = await readDoc(db, 'sources', sourceId);
        if (existingSource && (existingSource.aiProcessing !== 'allow' || existingSource.enabled === false || existingSource.deleted === true)) return { ...card, readState: 'body', allowAi: false };
        await seed(db, 'sources', sourceId, { ownerOpenid: owner, scope: 'private', schoolIds: [schoolId], type: 'ai_search', aiProcessing: 'allow', autoCollect: false, entryUrl: source.homepage, name: `${school.name}临时搜索结果` });
        const finalId = 'ai_search_item_' + digest([owner, schoolId, finalUrl]);
        await seed(db, 'items', finalId, { title: card.title, sourceName: card.sourceName, originalUrl: finalUrl, canonicalUrl: finalUrl, contentText: text, publishedAt: null, categories: card.categories, scope: 'private', ownerOpenid: owner, schoolIds: [schoolId], sourceId, aiProcessing: 'allow', status: 'published', importKind: 'website', aiSearchExpiresAt: new Date(now() + 86400000).toISOString(), createdAt: checkedAt, discoveredAt: checkedAt, updatedAt: checkedAt });
        const stored = await readDoc(db, 'items', finalId);
        return stored ? await existingCard([stored as ItemRow]) : { ...card, readState: 'unavailable', allowAi: false };
      } catch { return { ...card, readState: 'unavailable', reason: '发现本校候选页面，但本次正文未读取成功，请查看原文。' }; }
    }));
    await authorizeSchool(repo, owner, schoolId);
    const merged = [...candidates.filter((n): n is RecommendedNotice => n !== null), ...local.items];
    result.items = merged.filter((n, index) => merged.findIndex(other => Boolean(other.originalUrl && other.originalUrl === n.originalUrl) || other.id === n.id) === index).slice(0, 5);
    result.coverage = '已有来源与本次本校官方域名搜索结果；不保证覆盖全校公告。搜索摘要不是正文证据，临时正文最多保留 24 小时，不创建来源订阅。';
    if (lookupSaturated) result.coverage += ' 已有公告链接核验达到 200 条上限，未匹配的新链接仅展示线索，不自动读取或导入。';
    return result;
  }
  return {
    supports(action: string) { return actions.has(action); },
    async handle(action: string, input: Record<string, unknown>, identity: IdentityContext): Promise<unknown> {
      if (action.startsWith('ai.chat.')) return chat.handle(action, input, identity);
      if (action === 'ai.recommend') return recommendations(input, identity);
      if (!actions.has(action)) throw new AppError('ACTION_NOT_ALLOWED', '不支持的助手操作。');
      return profile.handle(action, input, identity);
    },
    /** Trusted server-to-server consumption only. Never accepts a browser owner id. */
    async notificationCandidates(identity: IdentityContext, schoolId: string) {
      const prefs = await profile.handle('ai.profile.get', { schoolId }, identity) as AiPreferences;
      const result = await profile.recommend(identity.dataOwnerId, schoolId);
      return { schoolId, generatedAt: new Date(now()).toISOString(), preferenceVersion: prefs.version, ...result };
    },
  };
}
