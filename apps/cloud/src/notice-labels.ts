import { noticeCategories } from '../../../packages/contracts/src/index';
import type { ItemRow } from './repository';
import { reject } from './errors';
export function originalCategories(row: ItemRow): string[] {
  return row.categories?.length ? row.categories : row.category ? [row.category] : [];
}
/** Display labels never replace Resource.categories: mail/private classification
 * always uses the original server metadata for authorization. */
export function displayedCategories(row: ItemRow): string[] {
  return row.personalCategories ?? originalCategories(row);
}
export function checkedLabels(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || !value.length || value.length > noticeCategories.length || value.some(label=>!noticeCategories.includes(label)))
    reject('VALIDATION_FAILED','请为公告选择至少一个有效标签，或恢复默认标签。');
  return [...new Set(value)];
}
