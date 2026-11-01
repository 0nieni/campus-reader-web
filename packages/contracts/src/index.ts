/** Browser inputs never contain a data owner, OPENID, or server identity. */
export interface AuthSession {
  uid: string;
  username: string | null;
  kind?:'guest'|'account';
  account?:{uid:string;username:string|null}|null;
}
export type {AnonymousState,AnonymousTransfer,AnonymousImport,AnonymousTransport} from './anonymous';
export {mcpScopes} from './mcp';
export type {McpScope,McpConnection,McpConnections,McpConsent,McpTransport} from './mcp';
export interface School {
  id: string;
  name: string;
  status: "ready" | "candidate" | "not_connected";
  announcementUrl?: string;
  homepage?: string;
  tags?: string[];
}
export interface SourceCollectionStats {newCount:number;existingCount:number;failedSources:number;skippedCount:number}
export interface SourceDisplayState {total:number;shown:number;hidden:number}
export interface InitialSchoolCollection {initialCollection?:{state:'ready'|'checking'|'unavailable';message:string}}
export interface SourceCatalogueEntry {id:string;name:string;kind:'school'|'public'|'personal';schoolId:string;url:string|null;categories:string[];showInFeed:boolean;collectable:boolean;state:'unchecked'|'ready'|'unavailable';checkedAt:string|null;count:number|null;message:string;verifiedAt?:string;nextRefreshAt?:string|null;errorCode?:string|null;collectionStatus?:'verified'|'pending'|'entry_only';directory?:{number:number;entryType:string;note:string}}
export interface SourceCatalogue {sources:SourceCatalogueEntry[];total:number;shown:number;hidden:number}
export interface SchoolSync { state: 'ready' | 'checking' | 'unavailable'; count: number; checkedAt: string | null; message: string; changed?:boolean; coverage?:string;stats?:SourceCollectionStats; sources?:Array<{name:string;url:string;state:'ready'|'unavailable';count:number;message:string;errorCode?:string|null;stats?:SourceCollectionStats}> }
export interface SchoolSourceCatalogue {
  school: School;
  coverage: string;
  sources: Array<{id:string;name:string;url:string;state:'unchecked'|'ready'|'unavailable';checkedAt:string|null;count:number|null;message:string;showInFeed?:boolean;errorCode?:string|null;stats?:SourceCollectionStats;nextRefreshAt?:string|null}>;
}
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
  excerpt?: string | null;
}
export interface NoticePage {
  items: Notice[];
  nextCursor: string | null;
  hiddenSourceCount?:number;
}
export const noticeCategories = ["school", "college", "competition", "academic", "activity", "scholarship", "mail"] as const;
export interface FeedFilters {
  sourceId?:string;
  keyword?: string;
  categories?: string[];
  period?: "7d" | "30d" | "90d" | "all";
}
export interface NoticeDetail extends Notice {
  materialArchive?: {expiresAt:string;attachmentNote:string;version:string;files:Array<{id:string;filename:string;kind:'article'|'attachment';state:string;message:string;collectedAt:string|null;expiresAt:string|null;characters:number;available:boolean}>};
  defaultCategories?: string[];
  categoriesCustomized?: boolean;
  bookmarked?: boolean;
  originalUrl: string | null;
  text: string;
  attachmentNote: string;
}
export interface Favorite { itemId: string; schoolId: string; schoolName: string; savedAt: string; notice: Notice | null }
export interface WebsiteSourceInput {name:string;entryUrl:string;type:'html_list'|'html_detail'|'rss'|'json_api';categories:string[];intervalMinutes:number;selectors:Record<string,string>;allowAi:boolean;authorized:boolean}
export interface WebsiteSource extends WebsiteSourceInput {id:string;enabled:boolean;lastSuccessAt:string|null;message:string;count:number;showInFeed?:boolean;nextRefreshAt?:string|null;lastAttemptAt?:string|null;lastErrorCode?:string|null;lastCollection?:SourceCollectionStats|null}
export interface AiConnection { provider: "deepseek" | "openai"; model: string; apiKey: string }
export type { AiProviderProtocol, AiProviderRef, AiSavedProvider, AiProviderSelection, AiProviderState, AiProviderSave } from './ai-providers';
import type { AiProviderActions, AiProviderRef } from './ai-providers';
export interface AiQuota { day: string; timezone: "Asia/Shanghai"; limit: number; used: number; held: number; remaining: number; resetsAt: string }
export interface ReadingDocument { reference: string; itemId: string; schoolId: string | null; title: string; originalUrl: string | null; version: string; markdown: string }
export interface ReadingPackage { docs: ReadingDocument[]; guide: string; manifest: Record<string, unknown>; batches: number; maxCalls: number; fingerprint: string }
export interface ReadingTask {
  id: string; schoolId: string; service: "official" | "byok"; provider: string; model: string;
  task: "summary" | "outline" | "answer"; state: "ready" | "running" | "complete" | "failed" | "uncertain" | "cancelled";
  step: number; totalSteps: number; title: string; result: string | null; message: string; failureCode?: string;
  expireAt: string; createdAt: string; quotaHeld: boolean;
  providerProfile?: AiProviderRef;
}
export interface AiStartInput {
  schoolId: string; itemIds: string[]; requestId: string; service: "official" | "byok";
  provider?: "deepseek" | "openai"; model?: string; providerProfile?: AiProviderRef; task: "summary" | "outline" | "answer"; question?: string; fingerprint?: string;
}
export type { AiPreferences, AiMemorySlot, AiMemoryItem, AiMemoryState, RecommendedNotice, AiRecommendations, AiSearchErrorCode, ChatReference, AiChatTurn, AiConversation } from './assistant';
import type { AssistantActions } from './assistant';
export interface ReminderChannels {browser:boolean;email:boolean}
export interface ReminderInput { id?:string; schoolId:string; itemId:string; label:string; dueAt:string; days:number[];channels?:ReminderChannels }
export interface ReminderChannelDelivery {status:'off'|'unconfigured'|'not_ready'|'pending'|'registration_failed'|'scheduled'|'accepted'|'failed'|'unknown'|'finished'|'retrying'|'limited';nextAt:string|null}
export interface ReminderDelivery {status:'unconfigured'|'no_device'|'pending'|'scheduled'|'later'|'registration_failed'|'sent'|'failed'|'unknown'|'finished';nextAt:string|null}
export interface Reminder extends Omit<ReminderInput,'dueAt'> { id:string; title:string; schoolName:string; createdAt:string; days:number[]; dueAt:string|null;delivery?:ReminderDelivery;channelDelivery?:{browser:ReminderChannelDelivery;email:ReminderChannelDelivery} }
export type ScheduledReminder=Reminder&{dueAt:string};
export interface NoticeWatch { id:string; schoolId:string; schoolName:string; keyword:string; createdAt:string }
export interface ReminderNotification { id:string; kind:'deadline'|'new_notice'; title:string; message:string; schoolId:string; itemId:string; createdAt:string; read:boolean }
export interface ReminderEmailState {configured:boolean;address:string|null;verified:boolean;enabled:boolean;suspended:boolean;usedToday:number;dailyLimit:number;identityKind?:'guest'|'account'}
export interface ReminderState { reminders:Reminder[]; watches:NoticeWatch[]; notifications:ReminderNotification[]; unread:number; checkedAt:string; more:boolean; pushConfigured:boolean; publicKey:string|null;deliveryMode?:'minute'|'daily';queueConfigured?:boolean;deviceCount?:number;scheduler?:'aliyun-fc'|'qstash';schedulerHealth?:'unconfigured'|'waiting'|'active'|'stale'|'failed';schedulerCheckedAt?:string|null;email?:ReminderEmailState }
export interface BrowserPushSubscription { endpoint:string; keys:{p256dh:string;auth:string} }
export interface GatewayActions extends AssistantActions, AiProviderActions {
  'reminders.state':{input:Record<string,never>;output:ReminderState};
  'reminders.add':{input:{schoolId:string;itemIds:string[]};output:ReminderState};
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
  'reminders.email.verify':{input:Record<string,never>;output:ReminderEmailState};
  'reminders.email.bind':{input:{email:string};output:ReminderEmailState};
  'reminders.email.test':{input:Record<string,never>;output:ReminderEmailState};
  'reminders.email.enable':{input:{enabled:boolean};output:ReminderEmailState};
  "sources.list":{input:{schoolId:string};output:{sources:WebsiteSource[]}};
  "sources.catalogue":{input:{schoolId:string};output:SourceCatalogue};
  "sources.public.refresh":{input:{schoolId:string;sourceId:string};output:{count:number;message:string;stats:SourceCollectionStats}};
  "sources.feedVisibility":{input:{schoolId:string;sourceId:string;visible:boolean};output:{visible:boolean}&InitialSchoolCollection};
  "sources.displayState":{input:{schoolId:string};output:SourceDisplayState};
  "sources.feedVisibilityAll":{input:{schoolId:string;visible:boolean};output:SourceDisplayState&InitialSchoolCollection};
  "sources.save":{input:{schoolId:string;sourceId?:string;source:WebsiteSourceInput};output:{id:string}};
  "sources.test":{input:{schoolId:string;sourceId:string};output:{count:number;titles:string[];message:string}};
  "sources.refresh":{input:{schoolId:string;sourceId:string};output:{count:number;message:string;stats?:SourceCollectionStats}};
  "sources.toggle":{input:{schoolId:string;sourceId:string;enabled:boolean};output:{enabled:boolean}};
  "sources.remove":{input:{schoolId:string;sourceId:string};output:{removed:boolean}};
  "session.get": { input: Record<string, never>; output: WorkspaceSession };
  "school.list": {
    input: { cursor?: string };
    output: { schools: School[]; nextCursor: string | null };
  };
  "school.select": { input: { schoolId: string }; output: WorkspaceSession };
  "school.sources": { input: { schoolId: string }; output: SchoolSourceCatalogue };
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
  "ai.status": { input: Record<string, never>; output: { quota: AiQuota; officialConfigured: boolean; searchConfigured?: boolean; officialModel: string | null; providers: Array<{ id: string; name: string; endpoint: string }> } };
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

export { chatSearchQuery, isSearchCapabilityQuestion } from './search-intent';
