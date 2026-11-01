import type { School, FeedFilters,SourceDisplayState } from "@campus/contracts";
import type { Resource, Scope } from "./scope";

export interface ItemRow extends Resource {
  aiSearchExpiresAt?: string;
  _id: string;
  title?: string;
  sourceName?: string;
  publishedAt?: string;
  status?: string;
  discoveredAt?: string;
  createdAt?: string;
  summary?: { oneLine?: string };
  autoSummary?: {text:string;basis:'body'|'title';version:string;checkedAt?:string};
  originalUrl?: string;
  contentText?: string;
  materialExpiresAt?: string;
  inlineMaterial?: boolean;
  materialPending?: boolean;
  materialArchive?: import('./material-archive').MaterialArchiveView;
  aiProcessing?: string;
  updatedAt?: string;
  personalCategories?: string[];
}
export interface Repository {
  selectedSchool(ownerId: string): Promise<string | null>;
  school(id: string): Promise<School | null>;
  schools(offset: number, limit: number): Promise<School[]>;
  selectSchool(ownerId: string, schoolId: string): Promise<void>;
  hiddenFeedSources?(ownerId:string,schoolId:string):Promise<string[]>;
  feedSourceSelection?(ownerId:string,schoolId:string):Promise<{shownIds:string[];hiddenIds:string[];noticeShownIds?:string[];noticeHiddenIds?:string[]}>;
  setSourceFeedVisibility?(ownerId:string,schoolId:string,sourceId:string,visible:boolean):Promise<{visible:boolean}>;
  sourceDisplayState?(ownerId:string,schoolId:string):Promise<SourceDisplayState>;
  setAllSourceFeedVisibility?(ownerId:string,schoolId:string,visible:boolean):Promise<SourceDisplayState>;
  scope(schoolId: string, ownerId: string): Promise<Scope>;
  items(
    scope: Scope,
    offset: number,
    limit: number,
    since: string,
    filters?: FeedFilters,
    feedOptions?: {hiddenSourceIds:string[];shownSourceIds?:string[]},
  ): Promise<ItemRow[]>;
  item(id: string): Promise<ItemRow | null>;
  /** Exact URL policy check, including revoked rows associated with this owner/school.
   * null means the bounded check was inconclusive; never use this as a feed. */
  itemsForUrlPolicy?(scope: Scope, url: string): Promise<ItemRow[] | null>;
  /** Invoked only after scope/ownership checks. Existing imported bodies are retained. */
  material?(row: ItemRow): Promise<ItemRow>;
  personalize?(row: ItemRow, ownerId: string): Promise<ItemRow>;
  setLabels?(ownerId: string, itemId: string, categories: string[] | null): Promise<void>;
}
