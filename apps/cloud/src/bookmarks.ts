import type { Favorite } from "@campus/contracts";
import type { Repository } from "./repository";
import type { IdentityContext } from "./identity";
import { identifier, authorizedItem, authorizeSchool } from "./access";
import { atomic, readDoc, transactionRow, type Database } from "./storage";
import { toNotice } from "./gateway";
import { reject } from "./errors";
import { itemVisible } from "./scope";
import { isRetained } from "./gateway";
interface Saved { itemId: string; schoolId: string; savedAt: string }
export function bookmarksService(db: Database, repo: Repository, options:{currentSchoolRequired?:boolean;now?:()=>number}={}) {
  const now=options.now||Date.now;
  const saved = async (owner: string): Promise<Saved[]> => {
    const row = await readDoc(db, "user_profiles", owner);
    return Array.isArray(row?.webBookmarks) ? row.webBookmarks : [];
  };
  return {
    async has(owner: string, schoolId: string, itemId: string) {
      return (await saved(owner)).some(row => row.itemId === itemId && row.schoolId === schoolId);
    },
    async handle(action: string, input: Record<string, unknown>, identity: IdentityContext) {
      const owner = identity.dataOwnerId;
      if (action === "favorites.set") {
        const schoolId = identifier(input.schoolId), itemId = identifier(input.itemId);
        if (typeof input.saved !== "boolean") reject("VALIDATION_FAILED", "请选择收藏或取消收藏。");
        if (input.saved) await authorizedItem(repo, owner, schoolId, itemId,now(),options.currentSchoolRequired!==false);
        await atomic(db, async tx => {
          const ref = tx.collection("user_profiles").doc(owner);
          const row = transactionRow((await ref.get()).data);
          const rows: Saved[] = (Array.isArray(row.webBookmarks) ? row.webBookmarks : []).filter((entry: Saved) => entry.itemId !== itemId || entry.schoolId !== schoolId);
          if (input.saved) {
            if (rows.length >= 500) reject("BOOKMARK_LIMIT", "最多保留 500 条收藏，请先移除部分收藏。");
            rows.unshift({ itemId, schoolId, savedAt: new Date(now()).toISOString() });
          }
          await ref.update({ webBookmarks: rows });
        });
        return { saved: input.saved };
      }
      const schoolId = input.schoolId === undefined ? null : identifier(input.schoolId);
      if (schoolId) await authorizeSchool(repo, owner, schoolId,options.currentSchoolRequired!==false);
      const cursor = input.cursor === undefined ? "0" : input.cursor;
      if (typeof cursor !== "string" || !/^\d{1,3}$/.test(cursor) || Number(cursor) > 500) reject("VALIDATION_FAILED", "收藏分页位置无效。");
      const rows = (await saved(owner)).filter(row => !schoolId || row.schoolId === schoolId);
      const offset = Number(cursor), page = rows.slice(offset, offset + 20);
      const schoolIds = [...new Set(page.map(entry => entry.schoolId))];
      const schools = new Map(await Promise.all(schoolIds.map(async id => [id, await repo.school(id)] as const)));
      const scopes = new Map(await Promise.all(schoolIds.filter(id => schools.get(id)).map(async id => [id, await repo.scope(id, owner)] as const)));
      const items: Favorite[] = await Promise.all(page.map(async entry => {
        const row = await repo.item(entry.itemId), scope = scopes.get(entry.schoolId);
        const notice = row && scope && row.status === "published" && itemVisible(row, scope) && isRetained(row, new Date(now() - 365 * 86400000).toISOString()) ? toNotice(repo.personalize ? await repo.personalize(row,owner) : row) : null;
        return { ...entry, schoolName: schools.get(entry.schoolId)?.name || "学校已移除", notice };
      }));
      return { items, nextCursor: rows.length > offset + 20 ? String(offset + 20) : null };
    },
  };
}
