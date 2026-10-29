import type { ChatReference } from '@campus/contracts';
import type { ItemRow, Repository } from './repository';
import { readDoc, type Database } from './storage';
import { authorizeSchool } from './access';
import { isRetained, originalUrl } from './gateway';
import { isPrivate, itemVisible, sourceVisible } from './scope';
import { approvedSchoolUrl } from './school-pages';
import { digest } from './reading-package';
import { AppError } from './errors';

function canonicalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

/** Link visibility only. These references must never become model evidence. */
export async function filterProgramReferences(db: Database, repo: Repository, owner: string, schoolId: string, refs: ChatReference[]): Promise<ChatReference[]> {
  try {
    const school = await authorizeSchool(repo, owner, schoolId);
    if (!refs.length) return [];
    const scope = await repo.scope(schoolId, owner);
    const since = new Date(Date.now() - 365 * 86400000).toISOString();
    const sourcePolicies = new Map<string, Promise<Record<string, any> | null>>();
    const policy = (id: string) => {
      if (!sourcePolicies.has(id)) sourcePolicies.set(id, readDoc(db, 'sources', id));
      return sourcePolicies.get(id)!;
    };
    async function visible(row: ItemRow): Promise<boolean> {
      if (row.status !== 'published' || (row as ItemRow & { deleted?: boolean }).deleted === true || !itemVisible(row, scope) || !isRetained(row, since)) return false;
      if (row.scope !== 'global' && row.schoolIds && !row.schoolIds.includes(schoolId)) return false;
      const ids = [...new Set([row.sourceId, ...(row.sourceIds || [])].filter((id): id is string => Boolean(id)))];
      if (!ids.length) return false;
      for (const id of ids) {
        const source = await policy(id);
        if (!source || source.enabled === false || source.deleted === true) return false;
        if ((source.scope || isPrivate(source)) ? !sourceVisible(source, schoolId, owner) : !scope.publicSourceIds.includes(id)) return false;
        if ((source.scope === 'school' || source.importKind === 'website' || source.type === 'ai_search' || isPrivate(source)) && !source.schoolIds?.includes(schoolId)) return false;
      }
      // import_only governs model input; an accessible original link remains visible.
      return true;
    }
    function unchanged(row: ItemRow, ref: ChatReference): boolean {
      return (row.title || '未命名公告') === ref.title && originalUrl(row) === ref.originalUrl;
    }
    let known: Map<string, ItemRow[]> | undefined, saturated = false;
    async function knownRows(url: string): Promise<ItemRow[]> {
      if (!known) {
        known = new Map();
        const seen = new Set<string>();
        // Include rows regardless of current status/policy: a revoked known URL
        // must not acquire a fresh snippet identity to bypass that policy.
        for (let offset = 0; offset < 200; offset += 100) {
          const page = (await repo.items(scope, offset, 100, since)).slice(0, 100);
          for (const row of page) {
            if (seen.has(row._id)) continue;
            seen.add(row._id);
            for (const key of new Set([canonicalUrl(originalUrl(row)), canonicalUrl(row.canonicalUrl)])) {
              if (key) known.set(key, [...(known.get(key) || []), row]);
            }
          }
          if (page.length < 100) break;
          if (offset === 100) saturated = true;
        }
      }
      return known.get(url) || [];
    }
    const accepted: ChatReference[] = [];
    for (const ref of refs.slice(0, 5)) {
      if (!ref || !/^[A-Za-z0-9_-]{1,200}$/.test(ref.itemId) || !ref.title || !ref.originalUrl || !canonicalUrl(ref.originalUrl)) continue;
      const row = await repo.item(ref.itemId) || await readDoc(db, 'items', ref.itemId) as ItemRow | null;
      if (row) {
        if (unchanged(row, ref) && await visible(row)) accepted.push(ref);
        continue;
      }
      const schoolSource = { id: schoolId, name: school.name, homepage: school.homepage || school.announcementUrl || '', announcementUrl: school.announcementUrl || school.homepage || '' };
      let url: string;
      try { url = approvedSchoolUrl(ref.originalUrl, schoolSource).href; } catch { continue; }
      if (url !== ref.originalUrl || ref.itemId !== 'ai_search_item_' + digest([owner, schoolId, url])) continue;
      const virtualSource = await policy('ai_search_' + digest([owner, schoolId]));
      if (virtualSource && (virtualSource.enabled === false || virtualSource.deleted === true || virtualSource.ownerOpenid !== owner || !virtualSource.schoolIds?.includes(schoolId) || virtualSource.type !== 'ai_search' || virtualSource.autoCollect !== false)) continue;
      const rows = await knownRows(url);
      if (!rows.length && saturated) continue;
      let allowed = true;
      for (const knownRow of rows) if (!unchanged(knownRow, ref) || !await visible(knownRow)) { allowed = false; break; }
      if (allowed) accepted.push(ref);
    }
    await authorizeSchool(repo, owner, schoolId);
    return accepted;
  } catch (error) {
    if (error instanceof AppError && ['STALE_SCOPE', 'SCHOOL_NOT_FOUND'].includes(error.code)) throw error;
    // Failed policy reads cannot authorize links or expose upstream diagnostics.
    return [];
  }
}
