/** Browser inputs never contain a data owner, OPENID, or server identity. */
export interface AuthSession {
  uid: string;
  username: string | null;
}
export interface School {
  id: string;
  name: string;
  status: "ready" | "candidate" | "not_connected";
  announcementUrl?: string;
  homepage?: string;
  tags?: string[];
}
export interface SchoolSync { state: 'ready' | 'checking' | 'unavailable'; count: number; checkedAt: string | null; message: string; changed?:boolean; coverage?:string; sources?:Array<{name:string;url:string;state:'ready'|'unavailable';count:number;message:string}> }
export interface SchoolRequest { id: string; state: 'pending' | 'submitted' | 'unknown'; message: string }
export interface WorkspaceSession {
  identity: AuthSession;
  school: School | null;
  legacyLinked: boolean;
  capabilities: { reading: true; ai: boolean; operations: false; schoolDirectory?: boolean; noticeLabels?: boolean; autoSummaries?:boolean };
}
export interface Notice {
  id: string;
  title: string;
  sourceName: string;
  publishedAt: string | null;
  categories: string[];
  summary: string | null;
  summaryBasis?: 'body'|'title';
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
  defaultCategories?: string[];
  categoriesCustomized?: boolean;
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
  "school.refresh": { input: { schoolId: string }; output: SchoolSync };
  "school.summarize": {input:{schoolId:string};output:{items:Array<{id:string;summary:string;summaryBasis:'body'|'title'}>;more:boolean}};
  "school.request": { input: { schoolName: string }; output: SchoolRequest };
  "feed.list": {
    input: FeedFilters & { schoolId: string; cursor?: string };
    output: NoticePage;
  };
  "feed.detail": {
    input: { schoolId: string; itemId: string };
    output: NoticeDetail;
  };
  "feed.labels.set": {input:{schoolId:string;itemId:string;categories:string[]|null};output:{categories:string[];customized:boolean}};
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
