import type { Database } from "../src/storage";
import type { Repository, ItemRow } from "../src/repository";
import { identify } from "../src/identity";
export const actor = { uid: "feature-owner", isAnonymous: false };
export const ownerConfig = { ownerUid: actor.uid };
export const identity = identify(actor, ownerConfig);
type Row = Record<string, any>;
const copy = <T>(value: T): T => structuredClone(value);
const matches = (row: Row, query: Row) => Object.entries(query).every(([key, condition]) => {
  const value = row[key];
  if (!condition || typeof condition !== "object" || !condition.op) return value === condition;
  if (condition.op === "lte") return value <= condition.value;
  if (condition.op === "gt") return value > condition.value;
  if (condition.op === "neq") return value !== condition.value;
  return false;
});
export function fixtureDb() {
  const collections = new Map<string, Map<string, Row>>();
  const collectionRows = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  };
  const patch = (old: Row, value: Row): Row => { const row = { ...old }; for (const [key, entry] of Object.entries(value)) { if (entry?.op === "remove") delete row[key]; else row[key] = copy(entry); } return row; };
  const query = (name: string) => {
    let filter: Row = {}, limit = Infinity, offset = 0;
    const builder = {
      where(value: Row) { filter = value; return builder; }, limit(value: number) { limit = value; return builder; }, skip(value: number) { offset = value; return builder; }, orderBy() { return builder; },
      async get() { return { data: [...collectionRows(name).values()].filter(row => matches(row, filter)).slice(offset, offset + limit).map(copy) }; },
      async add(value: Row) { const id = value._id; if (collectionRows(name).has(id)) throw Object.assign(new Error("duplicate"), { code: "DUPLICATE" }); collectionRows(name).set(id, copy(value)); return { id }; },
      doc(id: string) { return {
        async get() { return { data: copy(collectionRows(name).get(id) || {}) }; },
        async update(value: Row) { const old = collectionRows(name).get(id); if (!old) throw new Error("missing document"); collectionRows(name).set(id, patch(old, value)); return { updated: 1 }; },
        async set(value: Row) { collectionRows(name).set(id, { _id: id, ...copy(value) }); return { updated: 1 }; },
      }; },
    };
    return builder;
  };
  let queue = Promise.resolve();
  const db = {
    collection: query,
    command: { lte: (value: unknown) => ({ op: "lte", value }), gt: (value: unknown) => ({ op: "gt", value }), neq: (value: unknown) => ({ op: "neq", value }), remove: () => ({ op: "remove" }) },
    async startTransaction() {
      const previous = queue; let release!: () => void; queue = new Promise(resolve => { release = resolve; }); await previous;
      const writes = new Map<string, { name: string; id: string; row: Row }>();
      return {
        collection(name: string) { return { doc(id: string) { const key = `${name}/${id}`; return {
          async get() { return { data: copy(writes.get(key)?.row || collectionRows(name).get(id) || {}) }; },
          async update(value: Row) { const old = writes.get(key)?.row || collectionRows(name).get(id); if (!old) throw new Error("missing transaction doc"); writes.set(key, { name, id, row: patch(old, value) }); return { updated: 1 }; },
        }; } }; },
        async commit() { for (const { name, id, row } of writes.values()) collectionRows(name).set(id, copy(row)); release(); },
        async rollback() { release(); },
      };
    },
  } as unknown as Database;
  const items = new Map<string, ItemRow>([["notice", { _id: "notice", title: "测试竞赛", contentText: "这是仅用于测试的报名材料，截止日期未说明。", sourceId: "source", scope: "school", schoolIds: ["bjtu"], status: "published", publishedAt: new Date().toISOString(), originalUrl: "https://www.bjtu.edu.cn/test", updatedAt: "v1" }]]);
  let selected = "bjtu";
  const repo: Repository = {
    async selectedSchool() { return selected; },
    async school(id) { return ["bjtu", "other"].includes(id) ? { id, name: id, status: "ready" } : null; },
    async schools() { return []; }, async selectSchool(_owner, id) { selected = id; },
    async scope(schoolId, ownerId) { return { schoolId, ownerId, publicSourceIds: ["source"], privateSourceIds: [] }; },
    async items() { return [...items.values()]; }, async item(id) { return items.get(id) || null; },
    async itemsForUrlPolicy(scope, url) {
      const rows = [...items.values(), ...collectionRows('items').values() as Iterable<ItemRow>].filter(row =>
        (row.originalUrl?.split('#')[0] === url || row.canonicalUrl?.split('#')[0] === url) &&
        (row.ownerOpenid === scope.ownerId || !row.ownerOpenid && row.scope !== 'private' && (row.scope === 'global' || row.schoolIds?.includes(scope.schoolId) || scope.publicSourceIds.includes(row.sourceId || '') || row.sourceIds?.some(id => scope.publicSourceIds.includes(id)))));
      return rows.length > 200 ? null : rows;
    },
  };
  collectionRows("user_profiles").set(identity.dataOwnerId, { _id: identity.dataOwnerId, selectedSchoolId: "bjtu", unrelated: "preserve" });
  collectionRows("sources").set("source", { _id: "source", aiProcessing: "allow" });
  return { db, repo, items, rows: collectionRows };
}
