import cloudbase from "@cloudbase/node-sdk";
import type { School } from "@campus/contracts";
import type { Repository, ItemRow } from "./repository";
import { isPrivate, sourceVisible, type Resource, type Scope } from "./scope";
import { reject } from "./errors";
import { literalPattern } from "./filters";

type Database = ReturnType<ReturnType<typeof cloudbase.init>["database"]>;
const BJTU: School = { id: "bjtu", name: "北京交通大学", status: "ready" };
async function readCollection<T>(collection: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "DATABASE_COLLECTION_NOT_EXIST")
      reject("COLLECTION_REQUIRED", `云数据库缺少 ${collection} 集合。请新建空集合，设置为仅管理端可读写后重新连接。`);
    throw error;
  }
}
function schoolOf(row: Record<string, unknown>): School {
  return {
    id: String(row._id),
    name: String(row.name || row._id),
    status:
      row.status === "ready"
        ? "ready"
        : row.status === "candidate"
          ? "candidate"
          : "not_connected",
  };
}
export function cloudRepository(db: Database): Repository {
  const command = db.command;
  const queryItem = (scope: Scope) => {
    const publicOnly = command.and([
      { ownerOpenid: command.exists(false) },
      { sourceId: command.nin(scope.privateSourceIds) },
      command.nor([
        { scope: "private" },
        { type: "manual" },
        { category: "mail" },
        { categories: command.in(["mail"]) },
        { key: command.in(["mail-inbox", "manual-inbox"]) },
        {
          canonicalUrl: db.RegExp({ regexp: "^(mail|manual):", options: "i" }),
        },
      ]),
    ]);
    return command.or([
      { ownerOpenid: scope.ownerId },
      command.and([
        publicOnly,
        command.or([
          { scope: "global" },
          { scope: "school", schoolIds: command.in([scope.schoolId]) },
          {
            scope: command.exists(false),
            sourceId: command.in(scope.publicSourceIds),
          },
        ]),
      ]),
    ]);
  };
  const readOne = async (collection: string, id: string) => {
    const { data } = await readCollection(collection, () => db
      .collection(collection)
      .where({ _id: id })
      .limit(1)
      .get());
    return data[0] as Record<string, unknown> | undefined;
  };
  return {
    async selectedSchool(ownerId) {
      const row = await readOne("user_profiles", ownerId);
      return typeof row?.selectedSchoolId === "string"
        ? row.selectedSchoolId
        : null;
    },
    async school(id) {
      if (id === BJTU.id) return BJTU;
      const row = await readOne("schools", id);
      return row ? schoolOf(row) : null;
    },
    async schools(offset, limit) {
      // The built-in school participates in pagination once, without duplicating an imported row.
      const rows = await readCollection("schools", () => db
        .collection("schools")
        .where({ _id: command.neq(BJTU.id) })
        .orderBy("_id", "asc")
        .skip(Math.max(0, offset - 1))
        .limit(offset === 0 ? limit - 1 : limit)
        .get());
      return [...(offset === 0 ? [BJTU] : []), ...rows.data.map(schoolOf)];
    },
    async selectSchool(ownerId, schoolId) {
      const existing = await readOne("user_profiles", ownerId);
      const patch = {
        selectedSchoolId: schoolId,
        updatedAt: new Date().toISOString(),
      };
      if (existing)
        await db.collection("user_profiles").doc(ownerId).update(patch);
      else await db.collection("user_profiles").doc(ownerId).set(patch);
    },
    async scope(schoolId, ownerId) {
      const scope: Scope = {
        schoolId,
        ownerId,
        publicSourceIds: [],
        privateSourceIds: [],
      };
      for (let offset = 0; offset < 2000; offset += 100) {
        const { data } = await readCollection("sources", () => db
          .collection("sources")
          .orderBy("_id", "asc")
          .skip(offset)
          .limit(100)
          .get());
        for (const row of data as Array<Resource & { _id: string }>) {
          if (isPrivate(row)) scope.privateSourceIds.push(row._id);
          else if (sourceVisible(row, schoolId, ownerId))
            scope.publicSourceIds.push(row._id);
        }
        if (data.length < 100) return scope;
      }
      reject(
        "SOURCE_LIMIT_EXCEEDED",
        "来源目录超过本阶段的读取范围，请先调整来源分页配置。",
      );
    },
    async items(scope, offset, limit, since, filters = {}) {
      if (filters.categories?.length === 0) return [];
      const unknownDate = command.or([
        { publishedAt: command.exists(false) },
        { publishedAt: null },
      ]);
      const retained = command.or([
        { publishedAt: command.gte(since) },
        command.and([unknownDate, { discoveredAt: command.gte(since) }]),
        command.and([
          unknownDate,
          {
            discoveredAt: command.exists(false),
            createdAt: command.gte(since),
          },
        ]),
      ]);
      const predicates = [{ status: "published" }, queryItem(scope), retained];
      if(filters.sourceId)predicates.push(command.and([{sourceId:filters.sourceId}]));
      if (filters.categories?.length) predicates.push(command.or([
        { category: command.in(filters.categories) },
        { categories: command.in(filters.categories) },
      ]));
      if (filters.keyword) {
        const match = db.RegExp({ regexp: literalPattern(filters.keyword), options: "i" });
        predicates.push(command.or([{ title: match }, { contentText: match }, { "summary.oneLine": match }]));
      }
      const { data } = await readCollection("items", () => db
        .collection("items")
        .where(
          command.and(predicates),
        )
        .orderBy("publishedAt", "desc")
        .orderBy("_id", "desc")
        .skip(offset)
        .limit(limit)
        .get());
      return data as ItemRow[];
    },
    async item(id) {
      return ((await readOne("items", id)) as ItemRow | undefined) || null;
    },
  };
}
