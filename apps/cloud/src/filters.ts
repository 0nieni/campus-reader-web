import { noticeCategories, type FeedFilters } from "@campus/contracts";
import { reject } from "./errors";
import type { ItemRow } from "./repository";

export function filtersOf(input: Record<string, unknown>): FeedFilters {
  const { keyword, categories, period } = input;
  if (keyword !== undefined && (typeof keyword !== "string" || keyword.length > 100 || /[\u0000-\u001f\u007f]/.test(keyword)))
    reject("VALIDATION_FAILED", "关键词请使用不超过 100 个字符的单行文本。");
  if (categories !== undefined && (!Array.isArray(categories) || categories.length > noticeCategories.length || categories.some(category => !noticeCategories.includes(category))))
    reject("VALIDATION_FAILED", "分类筛选无效，请重新选择。");
  if (period !== undefined && (typeof period !== "string" || !["7d", "30d", "90d", "all"].includes(period)))
    reject("VALIDATION_FAILED", "时间范围无效，请重新选择。");
  return {
    ...(typeof keyword === "string" && keyword.trim() ? { keyword: keyword.trim() } : {}),
    ...(Array.isArray(categories) && categories.length ? { categories: [...new Set(categories)] } : {}),
    ...(period ? { period: period as FeedFilters["period"] } : {}),
  };
}
export function filterSince(filters: FeedFilters, now: number): string {
  const days = filters.period === "7d" ? 7 : filters.period === "30d" ? 30 : filters.period === "90d" ? 90 : 365;
  return new Date(now - days * 86400000).toISOString();
}
export function literalPattern(keyword: string): string {
  return keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function matchesFilters(row: ItemRow, filters: FeedFilters): boolean {
  if (filters.categories?.length && !filters.categories.some(category => row.category === category || row.categories?.includes(category))) return false;
  if (!filters.keyword) return true;
  return [row.title, row.contentText, row.summary?.oneLine].some(value => typeof value === "string" && value.toLowerCase().includes(filters.keyword!.toLowerCase()));
}
