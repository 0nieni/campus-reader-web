/** Browser inputs never contain a data owner, OPENID, or server identity. */
export interface AuthSession {
  uid: string;
  username: string | null;
}
export interface School {
  id: string;
  name: string;
  status: "ready" | "candidate" | "not_connected";
}
export interface WorkspaceSession {
  identity: AuthSession;
  school: School | null;
  legacyLinked: boolean;
  capabilities: { reading: true; ai: boolean; operations: false };
}
export interface Notice {
  id: string;
  title: string;
  sourceName: string;
  publishedAt: string | null;
  categories: string[];
  summary: string | null;
}
export interface NoticePage {
  items: Notice[];
  nextCursor: string | null;
}
export const noticeCategories = ["school", "college", "competition", "academic", "activity", "scholarship", "mail"] as const;
export interface FeedFilters {
  keyword?: string;
  categories?: string[];
  period?: "7d" | "30d" | "90d" | "all";
}
export interface NoticeDetail extends Notice {
  bookmarked?: boolean;
  originalUrl: string | null;
  text: string;
  attachmentNote: string;
}
export interface Favorite { itemId: string; schoolId: string; schoolName: string; savedAt: string; notice: Notice | null }
export interface AiConnection { provider: "deepseek" | "openai"; model: string; apiKey: string }
export interface AiQuota { day: string; timezone: "Asia/Shanghai"; limit: number; used: number; held: number; remaining: number; resetsAt: string }
export interface ReadingDocument { reference: string; itemId: string; schoolId: string | null; title: string; originalUrl: string | null; version: string; markdown: string }
export interface ReadingPackage { docs: ReadingDocument[]; guide: string; manifest: Record<string, unknown>; batches: number; maxCalls: number; fingerprint: string }
export interface ReadingTask {
  id: string; schoolId: string; service: "official" | "byok"; provider: string; model: string;
  task: "summary" | "outline" | "answer"; state: "ready" | "running" | "complete" | "failed" | "uncertain" | "cancelled";
  step: number; totalSteps: number; title: string; result: string | null; message: string; failureCode?: string;
  expireAt: string; createdAt: string; quotaHeld: boolean;
}
export interface AiStartInput {
  schoolId: string; itemIds: string[]; requestId: string; service: "official" | "byok";
  provider?: "deepseek" | "openai"; model?: string; task: "summary" | "outline" | "answer"; question?: string; fingerprint?: string;
}
export interface GatewayActions {
  "session.get": { input: Record<string, never>; output: WorkspaceSession };
  "school.list": {
    input: { cursor?: string };
    output: { schools: School[]; nextCursor: string | null };
  };
  "school.select": { input: { schoolId: string }; output: WorkspaceSession };
  "feed.list": {
    input: FeedFilters & { schoolId: string; cursor?: string };
    output: NoticePage;
  };
  "feed.detail": {
    input: { schoolId: string; itemId: string };
    output: NoticeDetail;
  };
  "favorites.list": { input: { schoolId?: string; cursor?: string }; output: { items: Favorite[]; nextCursor: string | null } };
  "favorites.set": { input: { schoolId: string; itemId: string; saved: boolean }; output: { saved: boolean } };
  "ai.status": { input: Record<string, never>; output: { quota: AiQuota; officialConfigured: boolean; officialModel: string | null; providers: Array<{ id: string; name: string; endpoint: string }> } };
  "ai.diagnose": { input: Record<string, never>; output: { code: string; message: string } };
  "ai.preview": { input: { schoolId: string; itemIds: string[] }; output: ReadingPackage };
  "ai.export": { input: { schoolId: string; itemIds: string[] }; output: ReadingPackage };
  "ai.start": { input: AiStartInput; output: ReadingTask };
  "ai.test": { input: { schoolId: string; requestId: string; provider: "deepseek" | "openai"; model: string }; output: ReadingTask };
  "ai.step": { input: { taskId: string; step: number; connection?: AiConnection }; output: ReadingTask };
  "ai.task": { input: { taskId: string }; output: ReadingTask };
  "ai.list": { input: { schoolId: string }; output: { tasks: ReadingTask[] } };
  "ai.cancel": { input: { taskId: string }; output: ReadingTask };
  "ai.resolve": { input: { taskId: string; charged: boolean }; output: ReadingTask };
}
export type GatewayAction = keyof GatewayActions;
export type GatewayResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };
