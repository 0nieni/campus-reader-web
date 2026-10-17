import type { Repository } from "./repository";
import { itemVisible } from "./scope";
import { reject } from "./errors";
import { isRetained } from "./gateway";
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) reject("VALIDATION_FAILED", "学校、公告或任务编号无效。");
  return value;
}
export async function authorizeSchool(repo: Repository, owner: string, schoolId: string, current = true) {
  const school = await repo.school(schoolId);
  if (!school) reject("SCHOOL_NOT_FOUND", "学校不在目录中。");
  if (current && await repo.selectedSchool(owner) !== schoolId) reject("STALE_SCOPE", "当前学校已变化，请重新选择资料。");
  return school;
}
export async function authorizedItem(repo: Repository, owner: string, schoolId: string, itemId: string, now = Date.now(), current = true) {
  await authorizeSchool(repo, owner, schoolId, current);
  const scope = await repo.scope(schoolId, owner);
  const row = await repo.item(itemId);
  if (!row || row.status !== "published" || !itemVisible(row, scope) || !isRetained(row, new Date(now - 365 * 86400000).toISOString()))
    reject("NOT_FOUND", "公告已不可读取或不在授权范围内。");
  return row;
}
