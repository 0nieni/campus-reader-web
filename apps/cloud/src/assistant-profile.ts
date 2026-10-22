import type { AiPreferences, AiRecommendations, RecommendedNotice } from '@campus/contracts';
import { noticeCategories } from '../../../packages/contracts/src/index';
import { authorizeSchool, authorizedItem, identifier } from './access';
import { reject } from './errors';
import { isRetained, originalUrl, toNotice } from './gateway';
import type { IdentityContext } from './identity';
import { displayedCategories } from './notice-labels';
import type { ItemRow, Repository } from './repository';
import { isPrivate, itemVisible, sourceVisible, type Resource, type Scope } from './scope';
import { atomic, readDoc, seed, transactionRow, type Database } from './storage';

const DAY = 86400000;
const BEHAVIOR_DAYS = 30;
const MAX_BEHAVIOR = 200;
type OpenSignal = { itemId: string; day: string; at: number; categories: string[] };
type Preferences = Omit<AiPreferences, 'schoolId'>;
interface SchoolProfile {
  preferences: Preferences;
  behavior: OpenSignal[];
  dismissed: string[];
  behaviorClearedAt: number;
}
type UserRow = Record<string, any>;
const categoryWords: Record<string, string[]> = {
  school: ['学校', '校园'], college: ['学院'], competition: ['竞赛', '比赛'],
  academic: ['学术', '讲座', '研讨'], activity: ['活动'], scholarship: ['奖学金', '助学金'],
};
const checkedDate = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const ownObject = (value: unknown): UserRow => value && typeof value === 'object' && !Array.isArray(value) ? value as UserRow : {};
function schoolProfile(row: UserRow, schoolId: string, current: number): SchoolProfile {
  const profiles = ownObject(row.aiAssistant);
  const stored = ownObject(Object.hasOwnProperty.call(profiles, schoolId) ? profiles[schoolId] : undefined);
  const pref = ownObject(stored.preferences);
  return {
    preferences: {
      interests: Array.isArray(pref.interests) ? pref.interests.filter((entry: unknown): entry is string => typeof entry === 'string').slice(0, 20) : [],
      goals: typeof pref.goals === 'string' ? pref.goals.slice(0, 1500) : '',
      learningEnabled: pref.learningEnabled === true,
      version: Number.isSafeInteger(pref.version) && pref.version >= 0 ? pref.version : 0,
    },
    behavior: pref.learningEnabled === true && Array.isArray(stored.behavior) ? stored.behavior.filter((entry: OpenSignal) => entry && typeof entry.at === 'number' && entry.at > current - BEHAVIOR_DAYS * DAY && entry.at <= current && typeof entry.itemId === 'string' && typeof entry.day === 'string' && Array.isArray(entry.categories)).slice(-MAX_BEHAVIOR) : [],
    dismissed: Array.isArray(stored.dismissed) ? stored.dismissed.filter((entry: unknown): entry is string => typeof entry === 'string').slice(-500) : [],
    behaviorClearedAt: typeof stored.behaviorClearedAt === 'number' ? stored.behaviorClearedAt : 0,
  };
}
function checkedPreferences(input: Record<string, unknown>): Preferences {
  if (!Array.isArray(input.interests) || input.interests.length > 20 || input.interests.some(value => typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)))
    reject('VALIDATION_FAILED', '关注点最多 20 个，每个最多 80 字且不能为空。');
  if (typeof input.goals !== 'string' || input.goals.length > 1500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.goals) || typeof input.learningEnabled !== 'boolean' || !Number.isSafeInteger(input.version) || Number(input.version) < 0)
    reject('VALIDATION_FAILED', '目标最多 1500 字，请提供有效的学习开关和偏好版本。');
  return { interests: [...new Set((input.interests as string[]).map(value => value.trim()))], goals: input.goals.trim(), learningEnabled: input.learningEnabled, version: Number(input.version) };
}
function checkedQuery(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 1500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) reject('VALIDATION_FAILED', '推荐问题最多 1500 字。');
  return value.trim();
}
function categories(row: ItemRow): string[] {
  const values = displayedCategories(row).filter(value => noticeCategories.includes(value as typeof noticeCategories[number]) && value !== 'mail');
  return values.length ? [...new Set(values)] : ['school'];
}
function mailOrManual(row: Resource): boolean {
  return row.type === 'manual' || ['mail-inbox', 'manual-inbox'].includes(row.key || '') || /^(mail|manual):/i.test(row.canonicalUrl || '') || row.category === 'mail' || Boolean(row.categories?.includes('mail'));
}
function automatic(row: ItemRow, scope: Scope, since: string): boolean {
  return row.status === 'published' && itemVisible(row, scope) && isRetained(row, since) && !mailOrManual(row) && (!isPrivate(row) || row.importKind === 'website');
}
function terms(text: string): string[] {
  return [...new Set([...text.split(/[\s,，、;；。!?！？]+/).filter(value => value.length > 1), ...Object.values(categoryWords).flat().filter(value => text.includes(value))])];
}
function matching(row: ItemRow, values: string[]): string | undefined {
  const labels = categories(row);
  const text = [row.title, row.contentText, ...labels, ...labels.flatMap(label => categoryWords[label] || [])].join('\n').toLowerCase();
  return values.find(value => text.includes(value.toLowerCase()));
}

/** Explicit preferences and bounded local signals only; this service never invokes a model or reads remote pages. */
export function assistantProfile(db: Database, repo: Repository, now = Date.now) {
  async function change<T>(owner: string, schoolId: string, run: (profile: SchoolProfile, row: UserRow) => T | Promise<T>): Promise<T> {
    await seed(db, 'user_profiles', owner, {});
    return atomic(db, async tx => {
      const ref = tx.collection('user_profiles').doc(owner);
      const row = transactionRow((await ref.get()).data);
      const profile = schoolProfile(row, schoolId, now());
      const result = await run(profile, row);
      await ref.update({ aiAssistant: { ...ownObject(row.aiAssistant), [schoolId]: profile } });
      return result;
    });
  }
  const publicPreferences = (schoolId: string, profile: SchoolProfile): AiPreferences => ({ schoolId, ...profile.preferences, interests: [...profile.preferences.interests] });

  function sourcePolicy(scope: Scope) {
    const sources = new Map<string, ReturnType<typeof readDoc>>();
    return async (row: ItemRow): Promise<boolean | null> => {
      const ids = [...new Set([row.sourceId, ...(row.sourceIds || [])].filter((id): id is string => Boolean(id)))];
      if (!ids.length) return null;
      let allowAi = row.aiProcessing !== 'import_only';
      for (const id of ids) {
        if (!sources.has(id)) sources.set(id, readDoc(db, 'sources', id));
        const source = await sources.get(id)!;
        if (!source || source.enabled === false || source.deleted === true || mailOrManual(source)) return null;
        // Server scope remains authoritative for legacy sources without explicit scope metadata.
        if ((source.scope || source.ownerOpenid) && !sourceVisible(source, scope.schoolId, scope.ownerId)) return null;
        if (!source.scope && !source.ownerOpenid && !scope.publicSourceIds.includes(id)) return null;
        if (isPrivate(source) && (row.importKind !== 'website' || source.importKind !== 'website' || source.ownerOpenid !== scope.ownerId || !source.schoolIds?.includes(scope.schoolId))) return null;
        if (source.aiProcessing === 'import_only') allowAi = false;
        if (isPrivate(row) && (row.aiProcessing !== 'allow' || source.aiProcessing !== 'allow')) allowAi = false;
      }
      return allowAi;
    };
  }

  async function recommend(owner: string, schoolId: string, query?: string): Promise<AiRecommendations> {
    schoolId = identifier(schoolId);
    const question = checkedQuery(query);
    await authorizeSchool(repo, owner, schoolId);
    const scope = await repo.scope(schoolId, owner), current = now();
    const since = new Date(current - 365 * DAY).toISOString();
    const { profile, bookmarks } = await change(owner, schoolId, (profile, row) => ({ profile, bookmarks: Array.isArray(row.webBookmarks) ? row.webBookmarks : [] }));
    const candidates: ItemRow[] = [], seen = new Set<string>();
    // Both database implementations support pages of 100; never inspect more than 200 rows.
    for (let offset = 0; offset < 200; offset += 100) {
      const page = (await repo.items(scope, offset, 100, since)).slice(0, 100);
      for (const row of page) if (!seen.has(row._id)) { seen.add(row._id); if (automatic(row, scope, since) && !profile.dismissed.includes(row._id)) candidates.push(row); }
      if (page.length < 100) break;
    }
    const policy = sourcePolicy(scope);
    const allowed: Array<{ row: ItemRow; allowAi: boolean }> = [];
    for (const row of candidates) {
      const allowAi = await policy(row);
      if (allowAi !== null) allowed.push({ row: repo.personalize ? await repo.personalize(row, owner) : row, allowAi });
    }
    const learned = new Set<string>();
    if (profile.preferences.learningEnabled) {
      for (const event of profile.behavior) for (const category of event.categories) learned.add(category);
      for (const saved of bookmarks) {
        const savedAt = Date.parse(saved.savedAt || '');
        if (saved.schoolId !== schoolId || savedAt <= profile.behaviorClearedAt || savedAt <= current - BEHAVIOR_DAYS * DAY || savedAt > current) continue;
        const row = allowed.find(candidate => candidate.row._id === saved.itemId)?.row;
        if (row) for (const category of categories(row)) learned.add(category);
      }
    }
    const explicit = [...profile.preferences.interests, ...terms(profile.preferences.goals)];
    const questionTerms = terms(question);
    const ranked = allowed.map(({ row, allowAi }) => {
      const hit = matching(row, explicit), questionHit = matching(row, questionTerms);
      const behaviorHit = categories(row).some(category => learned.has(category));
      return {
        row, allowAi, group: hit || questionHit ? 0 : behaviorHit ? 1 : 2,
        reason: hit ? `命中你填写的“${hit}”关注点` : questionHit ? `与本次问题中的“${questionHit}”相关` : behaviorHit ? '与近 30 天的近期阅读或收藏类别相关' : '按发布时间展示',
      };
    }).sort((a, b) => a.group - b.group || (Date.parse(checkedDate(b.row.publishedAt) || '') || 0) - (Date.parse(checkedDate(a.row.publishedAt) || '') || 0) || a.row._id.localeCompare(b.row._id));
    const selected = ranked.slice(0, 5);
    if (selected.length === 5) {
      const primary = categories(selected[0].row);
      const diverse = (row: ItemRow) => categories(row).every(category => !primary.includes(category));
      if (!selected.some(candidate => diverse(candidate.row))) {
        const alternative = ranked.find(candidate => diverse(candidate.row));
        if (alternative) selected[4] = alternative;
      }
    }
    const items: RecommendedNotice[] = selected.map(({ row, allowAi, reason }) => ({
      ...toNotice(row), originalUrl: originalUrl(row), reason, readState: row.contentText?.trim() ? 'body' : 'title_only',
      checkedAt: checkedDate(row.updatedAt) || checkedDate(row.discoveredAt) || checkedDate(row.createdAt), allowAi,
    }));
    return { items, search: { state: 'unconfigured', message: '联网搜索未配置，当前仅使用已有公告。' }, coverage: `已检查最多 200 条已有公告，仅展示当前学校和账号可见且来源可用的资料${seen.size >= 200 ? '；其余公告未在本次范围内' : ''}。` };
  }

  return {
    recommend,
    async handle(action: string, input: Record<string, unknown>, identity: IdentityContext): Promise<unknown> {
      const owner = identity.dataOwnerId, schoolId = identifier(input.schoolId);
      await authorizeSchool(repo, owner, schoolId);
      if (action === 'ai.recommend') return recommend(owner, schoolId, input.query as string | undefined);
      if (action === 'ai.profile.get') return change(owner, schoolId, profile => publicPreferences(schoolId, profile));
      if (action === 'ai.profile.save') {
        const preferences = checkedPreferences(input);
        return change(owner, schoolId, profile => {
          if (profile.preferences.version !== preferences.version) reject('PROFILE_CONFLICT', '关注点已在其他页面修改，请重新读取后保存。');
          if (!preferences.learningEnabled) { profile.behavior = []; profile.behaviorClearedAt = now(); }
          profile.preferences = { ...preferences, version: preferences.version + 1 };
          return publicPreferences(schoolId, profile);
        });
      }
      if (action === 'ai.profile.clearBehavior') return change(owner, schoolId, profile => {
        profile.behavior = []; profile.behaviorClearedAt = now();
        return publicPreferences(schoolId, profile);
      });
      if (action === 'ai.behavior') {
        const itemId = identifier(input.itemId), current = now();
        const row = await authorizedItem(repo, owner, schoolId, itemId, current);
        const scope = await repo.scope(schoolId, owner);
        if (!automatic(row, scope, new Date(current - 365 * DAY).toISOString()) || await sourcePolicy(scope)(row) === null) return { recorded: false };
        const labels = categories(repo.personalize ? await repo.personalize(row, owner) : row);
        return change(owner, schoolId, profile => {
          const day = new Date(current + 8 * 3600000).toISOString().slice(0, 10);
          if (!profile.preferences.learningEnabled || profile.behavior.some(event => event.day === day && event.itemId === itemId)) return { recorded: false };
          const available = labels.filter(category => profile.behavior.filter(event => event.day === day && event.categories.includes(category)).length < 5);
          if (!available.length) return { recorded: false };
          profile.behavior.push({ itemId, day, at: current, categories: available });
          profile.behavior = profile.behavior.slice(-MAX_BEHAVIOR);
          return { recorded: true };
        });
      }
      if (action === 'ai.dismiss') {
        const itemId = identifier(input.itemId);
        if (typeof input.dismissed !== 'boolean') reject('VALIDATION_FAILED', '请选择隐藏或恢复此公告。');
        if (input.dismissed) await authorizedItem(repo, owner, schoolId, itemId, now());
        return change(owner, schoolId, profile => {
          profile.dismissed = profile.dismissed.filter(id => id !== itemId);
          if (input.dismissed) {
            if (profile.dismissed.length >= 500) reject('DISMISS_LIMIT', '已隐藏 500 条公告，请先恢复部分公告。');
            profile.dismissed.push(itemId);
          }
          return { dismissed: input.dismissed };
        });
      }
      reject('ACTION_NOT_ALLOWED', '此 AI 阅读操作尚未开放。');
    },
  };
}
