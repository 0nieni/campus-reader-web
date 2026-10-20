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
  capabilities: { reading: true; ai: boolean; operations: false; schoolDirectory?: boolean; noticeLabels?: boolean; websiteSources?:boolean; reminders?:boolean };
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
  defaultCategories?: string[];
  categoriesCustomized?: boolean;
  bookmarked?: boolean;
  originalUrl: string | null;
  text: string;
  attachmentNote: string;
}
export interface Favorite { itemId: string; schoolId: string; schoolName: string; savedAt: string; notice: Notice | null }
export interface WebsiteSourceInput {name:string;entryUrl:string;type:'html_list'|'html_detail'|'rss'|'json_api';categories:string[];intervalMinutes:number;selectors:Record<string,string>;allowAi:boolean;authorized:boolean}
export interface WebsiteSource extends WebsiteSourceInput {id:string;enabled:boolean;lastSuccessAt:string|null;message:string;count:number}
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
export interface ReminderInput { id?:string; schoolId:string; itemId:string; label:string; dueAt:string; days:number[] }
export interface Reminder extends ReminderInput { id:string; title:string; schoolName:string; createdAt:string; days:number[] }
export interface NoticeWatch { id:string; schoolId:string; schoolName:string; keyword:string; createdAt:string }
export interface ReminderNotification { id:string; kind:'deadline'|'new_notice'; title:string; message:string; schoolId:string; itemId:string; createdAt:string; read:boolean }
export interface ReminderState { reminders:Reminder[]; watches:NoticeWatch[]; notifications:ReminderNotification[]; unread:number; checkedAt:string; more:boolean; pushConfigured:boolean; publicKey:string|null }
export interface BrowserPushSubscription { endpoint:string; keys:{p256dh:string;auth:string} }
export interface GatewayActions {
  'reminders.state':{input:Record<string,never>;output:ReminderState};
  'reminders.save':{input:ReminderInput;output:ReminderState};
  'reminders.remove':{input:{id:string};output:ReminderState};
  'reminders.watch.save':{input:{id?:string;schoolId:string;keyword:string};output:ReminderState};
  'reminders.watch.remove':{input:{id:string};output:ReminderState};
  'reminders.read':{input:{id?:string};output:ReminderState};
  'reminders.export':{input:{id?:string};output:{content:string;filename:string}};
  'reminders.push.subscribe':{input:{subscription:BrowserPushSubscription};output:{id:string}};
  'reminders.push.status':{input:{endpoint:string};output:{active:boolean}};
  'reminders.push.unsubscribe':{input:{endpoint:string};output:{removed:boolean}};
  'reminders.push.test':{input:{endpoint:string};output:{accepted:boolean}};
  "sources.list":{input:{schoolId:string};output:{sources:WebsiteSource[]}};
  "sources.save":{input:{schoolId:string;sourceId?:string;source:WebsiteSourceInput};output:{id:string}};
  "sources.test":{input:{schoolId:string;sourceId:string};output:{count:number;titles:string[];message:string}};
  "sources.refresh":{input:{schoolId:string;sourceId:string};output:{count:number;message:string}};
  "sources.toggle":{input:{schoolId:string;sourceId:string;enabled:boolean};output:{enabled:boolean}};
  "sources.remove":{input:{schoolId:string;sourceId:string};output:{removed:boolean}};
  "session.get": { input: Record<string, never>; output: WorkspaceSession };
  "school.list": {
    input: { cursor?: string };
    output: { schools: School[]; nextCursor: string | null };
  };
  "school.select": { input: { schoolId: string }; output: WorkspaceSession };
  "school.refresh": { input: { schoolId: string }; output: SchoolSync };
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
