import type { School, FeedFilters } from "@campus/contracts";
import type { Resource, Scope } from "./scope";

export interface ItemRow extends Resource {
  _id: string;
  title?: string;
  sourceName?: string;
  publishedAt?: string;
  status?: string;
  discoveredAt?: string;
  createdAt?: string;
  summary?: { oneLine?: string };
  originalUrl?: string;
  contentText?: string;
  aiProcessing?: string;
  updatedAt?: string;
}
export interface Repository {
  selectedSchool(ownerId: string): Promise<string | null>;
  school(id: string): Promise<School | null>;
  schools(offset: number, limit: number): Promise<School[]>;
  selectSchool(ownerId: string, schoolId: string): Promise<void>;
  scope(schoolId: string, ownerId: string): Promise<Scope>;
  items(
    scope: Scope,
    offset: number,
    limit: number,
    since: string,
    filters?: FeedFilters,
  ): Promise<ItemRow[]>;
  item(id: string): Promise<ItemRow | null>;
}
