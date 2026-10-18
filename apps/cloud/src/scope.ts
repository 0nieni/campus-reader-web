/** Adapted from the old workspace.ts. No global legacy-private fallback on Web. */
export interface Resource {
  _id?: string;
  scope?: string;
  ownerOpenid?: string;
  schoolIds?: string[];
  sourceId?: string;
  sourceIds?: string[];
  key?: string;
  type?: string;
  category?: string;
  categories?: string[];
  canonicalUrl?: string;
  siteUrl?: string;
  entryUrl?: string;
  importKind?:string;
}
export interface Scope {
  schoolId: string;
  ownerId: string;
  publicSourceIds: string[];
  privateSourceIds: string[];
}
const bjtuKeys = new Set(["bjtu-tzgg", "bjtu-bksy", "bjtu-cs-tzgg"]);
const globalKeys = new Set(["ciscn-announcement", "lanqiao-competition"]);

export function isPrivate(row: Resource): boolean {
  return (
    Boolean(row.ownerOpenid) ||
    row.scope === "private" ||
    row.type === "manual" ||
    ["mail-inbox", "manual-inbox"].includes(row.key || "") ||
    /^(mail|manual):/i.test(row.canonicalUrl || "") ||
    row.category === "mail" ||
    Boolean(row.categories?.includes("mail"))
  );
}
export function sourceVisible(
  row: Resource,
  schoolId: string,
  ownerId: string,
): boolean {
  if (isPrivate(row)) return row.ownerOpenid === ownerId;
  if (row.scope === "global") return true;
  if (row.scope === "school") return Boolean(row.schoolIds?.includes(schoolId));
  if (row.scope) return false;
  if (globalKeys.has(row.key || "")) return true;
  if (schoolId !== "bjtu") return false;
  if (bjtuKeys.has(row.key || "")) return true;
  try {
    return /(^|\.)bjtu\.edu\.cn$/.test(
      new URL(row.entryUrl || row.siteUrl || "").hostname,
    );
  } catch {
    return false;
  }
}
export function itemVisible(row: Resource, scope: Scope): boolean {
  if (isPrivate(row)) return row.ownerOpenid === scope.ownerId && (row.importKind!=='website'||Boolean(row.schoolIds?.includes(scope.schoolId)));
  if (row.sourceId && scope.privateSourceIds.includes(row.sourceId))
    return false;
  if (row.scope === "global") return true;
  if (row.scope === "school")
    return Boolean(row.schoolIds?.includes(scope.schoolId));
  if (row.scope) return false;
  // Legacy private-source children without an explicit owner remain isolated.
  return Boolean(row.sourceId && scope.publicSourceIds.includes(row.sourceId));
}
