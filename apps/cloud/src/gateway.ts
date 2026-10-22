import type {
  GatewayResult,
  Notice,
  NoticeDetail,
  WorkspaceSession,
} from "@campus/contracts";
import { AppError, reject } from "./errors";
import {
  identify,
  type Caller,
  type OwnerConfig,
  type IdentityContext,
} from "./identity";
import { itemVisible } from "./scope";
import type { Repository, ItemRow } from "./repository";
import { filtersOf, filterSince, matchesFilters } from "./filters";
import { checkedLabels, displayedCategories, originalCategories } from './notice-labels';

const fields: Record<string, string[]> = {
  'reminders.state':[],
  'reminders.add':['schoolId','itemIds'],
  'reminders.save':['id','schoolId','itemId','label','dueAt','days','channels'],
  'reminders.remove':['id'],
  'reminders.watch.save':['id','schoolId','keyword'],
  'reminders.watch.remove':['id'],
  'reminders.read':['id'],
  'reminders.export':['id'],
  'reminders.push.subscribe':['subscription'],
  'reminders.push.status':['endpoint'],
  'reminders.push.unsubscribe':['endpoint'],
  'reminders.push.test':['endpoint'],
  'reminders.email.verify':[],
  'reminders.email.test':[],
  'reminders.email.enable':['enabled'],
  'sources.list':['schoolId'],
  'sources.save':['schoolId','sourceId','source'],
  'sources.test':['schoolId','sourceId'],
  'sources.refresh':['schoolId','sourceId'],
  'sources.toggle':['schoolId','sourceId','enabled'],
  'sources.remove':['schoolId','sourceId'],
  "session.get": [],
  "school.list": ["cursor"],
  "school.select": ["schoolId"],
  "school.refresh": ["schoolId"],
  "school.request": ["schoolName"],
  "feed.list": ["schoolId", "cursor", "keyword", "categories", "period"],
  "feed.detail": ["schoolId", "itemId"],
  "feed.labels.set": ["schoolId", "itemId", "categories"],
  "favorites.list": ["schoolId", "cursor"],
  "favorites.set": ["schoolId", "itemId", "saved"],
  "ai.status": [],
  "ai.diagnose": [],
  "ai.preview": ["schoolId", "itemIds"],
  "ai.export": ["schoolId", "itemIds"],
  "ai.start": ["schoolId", "itemIds", "requestId", "service", "provider", "model", "task", "question", "fingerprint"],
  "ai.test": ["schoolId", "requestId", "provider", "model"],
  "ai.step": ["taskId", "step", "connection"],
  "ai.task": ["taskId"],
  "ai.list": ["schoolId"],
  "ai.cancel": ["taskId"],
  "ai.resolve": ["taskId", "charged"],
  "ai.relay": ["payload", "signature"],
};
function inputOf(event: unknown): {
  action: string;
  input: Record<string, unknown>;
} {
  if (!event || typeof event !== "object" || Array.isArray(event))
    reject("VALIDATION_FAILED", "请求格式无效。");
  const envelope = event as Record<string, unknown>;
  // CloudBase adds transport metadata (tcbContext observed in real Web calls).
  // Neither metadata field is used: only the server SDK Caller is trusted.
  if (Object.keys(envelope).some((k) => !["action", "input", "userInfo", "tcbContext"].includes(k)))
    reject("VALIDATION_FAILED", "请求包含不支持的字段。");
  const action = typeof envelope.action === "string" ? envelope.action : "";
  if (!Object.hasOwnProperty.call(fields, action))
    reject("ACTION_NOT_ALLOWED", "此操作尚未向网页开放。");
  const input = envelope.input ?? {};
  if (!input || typeof input !== "object" || Array.isArray(input))
    reject("VALIDATION_FAILED", "操作参数无效。");
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some((k) => !fields[action].includes(k)))
    reject("VALIDATION_FAILED", "操作参数包含不支持的字段。");
  return { action, input: data };
}
function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value))
    reject("VALIDATION_FAILED", "学校或公告编号无效。");
  return value;
}
function offsetOf(value: unknown): number {
  if (value === undefined) return 0;
  if (
    typeof value !== "string" ||
    !/^\d{1,6}$/.test(value) ||
    Number(value) > 100000
  )
    reject("VALIDATION_FAILED", "分页位置无效，请刷新后重试。");
  return Number(value);
}
export function toNotice(row: ItemRow): Notice {
  return {
    id: row._id,
    title: String(row.title || "未命名公告"),
    sourceName: String(row.sourceName || "来源未标注"),
    publishedAt: row.publishedAt || null,
    categories: displayedCategories(row),
    summary: null,
  };
}
export function originalUrl(row: ItemRow): string | null {
  if (/^mail:/i.test(row.canonicalUrl || "")) return null;
  try {
    const url = new URL(row.originalUrl || "");
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function isRetained(row: ItemRow, since: string): boolean {
  const date = row.publishedAt || row.discoveredAt || row.createdAt;
  return Boolean(
    date &&
      Number.isFinite(Date.parse(date)) &&
      Date.parse(date) >= Date.parse(since),
  );
}
async function session(
  identity: IdentityContext,
  repo: Repository,
  directory = false,
  websites = false,
  reminders = false,
): Promise<WorkspaceSession> {
  const id = await repo.selectedSchool(identity.dataOwnerId);
  return {
    identity: { uid: identity.uid, username: null },
    school: id ? await repo.school(id) : null,
    legacyLinked: identity.legacyLinked,
    capabilities: { reading: true, ai: true, operations: false, ...(directory ? { schoolDirectory:true } : {}), ...(websites?{websiteSources:true}:{}), ...(reminders?{reminders:true}:{}), ...(repo.setLabels ? {noticeLabels:true} : {}) },
  };
}

export function createGateway(
  repo: Repository,
  config: OwnerConfig,
  now: () => number = Date.now,
  features?: { reminders?:{handle(action:string,input:Record<string,unknown>,identity:IdentityContext):Promise<unknown>}; websites?:{handle(action:string,input:Record<string,unknown>,identity:IdentityContext):Promise<unknown>}; bookmarks?: { handle(action: string, input: Record<string, unknown>, identity: IdentityContext): Promise<unknown>; has(ownerId: string, schoolId: string, itemId: string): Promise<boolean> }; ai?: { handle(action: string, input: Record<string, unknown>, identity: IdentityContext): Promise<unknown> }; directory?: { refresh(schoolId:string):Promise<unknown>; request(name:unknown,identity:IdentityContext):Promise<unknown> } },
) {
  return async (
    event: unknown,
    caller: Caller,
  ): Promise<GatewayResult<unknown>> => {
    let operation = "身份验证";
    try {
      const identity = identify(caller, config);
      const { action, input } = inputOf(event);
      operation = action;
      const filters = action === "feed.list" ? filtersOf(input) : {};
      if(action.startsWith('reminders.')){
        if(!features?.reminders)reject('SERVICE_UNAVAILABLE','此环境尚未接通提醒服务。');
        return{ok:true,data:await features.reminders.handle(action,input,identity)};
      }
      if(action.startsWith('sources.')){
        if(!features?.websites)reject('SERVICE_UNAVAILABLE','网站来源管理尚未接通。');
        return{ok:true,data:await features.websites.handle(action,input,identity)};
      }
      if (action.startsWith("favorites.")) {
        if (!features?.bookmarks) reject("SERVICE_UNAVAILABLE", "收藏服务尚未接通。");
        return { ok: true, data: await features.bookmarks.handle(action, input, identity) };
      }
      if (action.startsWith("ai.")) {
        if (!features?.ai) reject("AI_WORKER_REQUIRED", "AI 专用函数尚未接通，请检查部署。");
        return { ok: true, data: await features.ai.handle(action, input, identity) };
      }
      if (action === "session.get")
        return { ok: true, data: await session(identity, repo,Boolean(features?.directory),Boolean(features?.websites),Boolean(features?.reminders)) };
      if (action === 'school.request') {
        if (!features?.directory) reject('SERVICE_UNAVAILABLE','学校申请服务尚未接通。');
        return { ok:true,data:await features.directory.request(input.schoolName,identity) };
      }
      if (action === "school.list") {
        const offset = offsetOf(input.cursor);
        const schools = await repo.schools(offset, 51);
        return {
          ok: true,
          data: {
            schools: schools.slice(0, 50),
            nextCursor: schools.length > 50 ? String(offset + 50) : null,
          },
        };
      }
      const schoolId = text(input, "schoolId");
      const school = await repo.school(schoolId);
      if (!school) reject("SCHOOL_NOT_FOUND", "学校不在目录中，请重新选择。");
      if (action === "school.select") {
        await repo.selectSchool(identity.dataOwnerId, schoolId);
        return { ok: true, data: await session(identity, repo,Boolean(features?.directory),Boolean(features?.websites),Boolean(features?.reminders)) };
      }
      if ((await repo.selectedSchool(identity.dataOwnerId)) !== schoolId)
        reject("STALE_SCOPE", "当前学校已变化，请刷新后重试。");
      if (action === 'school.refresh') {
        if (!features?.directory) reject('SERVICE_UNAVAILABLE','学校公开公告读取服务尚未接通。');
        return {ok:true,data:await features.directory.refresh(schoolId)};
      }
      const scope = await repo.scope(schoolId, identity.dataOwnerId);
      const since = filterSince(filters, now());
      if (action === "feed.list") {
        if (filters.categories?.length === 0) return {ok:true,data:{items:[],nextCursor:null}};
        const offset = offsetOf(input.cursor);
        const rows = await repo.items(scope, offset, 21, since, filters);
        // DB predicates operate before pagination; recheck every returned row for defense in depth.
        if (
          rows.some(
            (row) =>
              !itemVisible(row, scope) ||
              row.status !== "published" ||
              !isRetained(row, since) ||
              !matchesFilters(row, filters),
          )
        )
          reject(
            "SCOPE_CHECK_FAILED",
            "资料范围校验失败，请联系维护者检查来源配置。",
          );
        return {
          ok: true,
          data: {
            items: rows.slice(0, 20).map(toNotice),
            nextCursor: rows.length > 20 ? String(offset + 20) : null,
          },
        };
      }
      let row = await repo.item(text(input, "itemId"));
      if (
        !row ||
        !itemVisible(row, scope) ||
        row.status !== "published" ||
        !isRetained(row, since)
      )
        reject("NOT_FOUND", "公告不存在或不在当前授权范围内。");
      if (action === 'feed.labels.set') {
        if (!repo.setLabels) reject('SERVICE_UNAVAILABLE','此环境尚未启用个人公告标签。');
        const categories = checkedLabels(input.categories);
        await repo.setLabels(identity.dataOwnerId,row._id,categories);
        return {ok:true,data:{categories:categories ?? originalCategories(row),customized:categories !== null}};
      }
      let materialNote = '';
      if (repo.material) {
        try { row = await repo.material(row); }
        catch (error) {
          if (!(error instanceof AppError) || !['NO_MATERIAL','SOURCE_UNAVAILABLE','SOURCE_LOGIN_REQUIRED','SOURCE_RESTRICTED','SOURCE_NOT_FOUND'].includes(error.code)) throw error;
          materialNote = error.message;
        }
      }
      if (repo.personalize) row = await repo.personalize(row,identity.dataOwnerId);
      const detail: NoticeDetail = {
        ...toNotice(row),
        text: row.contentText || "",
        defaultCategories: originalCategories(row),
        categoriesCustomized: row.personalCategories !== undefined,
        originalUrl: originalUrl(row),
        attachmentNote: (materialNote ? materialNote + ' ' : '') + "本阶段未读取附件正文，请以公告原文和附件为准。",
        ...(features?.bookmarks ? { bookmarked: await features.bookmarks.has(identity.dataOwnerId, schoolId, row._id) } : {}),
      };
      return { ok: true, data: detail };
    } catch (error) {
      if (error instanceof AppError)
        return { ok: false, code: error.code, message: error.message };
      // Only bounded SDK error codes aid setup; never expose raw messages or payloads.
      const rawCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      const diagnostic = /^(?:[A-Z][A-Z0-9_]{1,63}|-?\d{1,10})$/.test(rawCode) ? rawCode : "UNKNOWN";
      return {
        ok: false,
        code: "SERVICE_UNAVAILABLE",
        message: `云端读取失败（${operation} / ${diagnostic}），请检查集合和索引配置后重试。`,
      };
    }
  };
}
