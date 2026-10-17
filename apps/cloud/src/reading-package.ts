import { createHash } from "node:crypto";
import type { ReadingPackage, ReadingDocument } from "@campus/contracts";
import type { Repository } from "./repository";
import { authorizedItem, identifier } from "./access";
import { originalUrl } from "./gateway";
import { READING_GUIDE, GUIDE_VERSION } from "./reading-guide";
import { reject } from "./errors";
import { isPrivate } from "./scope";
import { readDoc, type Database } from "./storage";
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function readingPackage(db: Database, repo: Repository, owner: string, schoolId: string, ids: unknown, forModel = true): Promise<ReadingPackage> {
  if (!Array.isArray(ids) || !ids.length || ids.length > 8) reject("VALIDATION_FAILED", "请明确选择 1～8 篇公告。");
  const unique = [...new Set(ids.map(identifier))];
  const rows = await Promise.all(unique.map(id=>authorizedItem(repo,owner,schoolId,id)));
  const materials = await Promise.all(rows.map(row=>repo.material ? repo.material(row) : row));
  const docs: ReadingDocument[] = [];
  for (let index = 0; index < unique.length; index++) {
    const itemId = unique[index]!, row = materials[index]!;
    if (!row.contentText?.trim()) reject("NO_MATERIAL", "所选公告缺少正文，请取消选择。");
    if (forModel) {
      const sourceIds = [...new Set([row.sourceId, ...(row.sourceIds || [])].filter((id): id is string => Boolean(id)))];
      if (row.aiProcessing === "import_only" || !sourceIds.length) reject("AI_POLICY_BLOCKED", "所选资料仅供导入或缺少来源策略，不能发送模型。");
      const sources = await Promise.all(sourceIds.map(id => readDoc(db, "sources", id)));
      if (sources.some(source => !source || source.aiProcessing === "import_only") ||
          (isPrivate(row) && (row.aiProcessing !== "allow" || sources.some(source => source?.aiProcessing !== "allow"))))
        reject("AI_POLICY_BLOCKED", "所选资料的来源不允许 AI 处理；私人资料需明确允许。");
    }
    const reference = `R${docs.length + 1}`, url = originalUrl(row);
    const metadata = { school_id: row.scope === "global" ? null : schoolId, item_id: itemId, title: row.title || "未命名公告", source_name: row.sourceName || "未提供", original_url: url, published_at: row.publishedAt || null, version: row.updatedAt || row.createdAt || null };
    const markdown = `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\nreference: ${reference}\n---\n\n# ${row.title || "未命名公告"}\n\n${row.contentText}\n\n## 附件状态\n本次未提供附件正文，不代表原公告没有附件。`;
    docs.push({ reference, itemId, schoolId: metadata.school_id, title: metadata.title, originalUrl: url, version: digest([metadata, row.contentText, row.aiProcessing]), markdown });
  }
  const chars = docs.reduce((sum, doc) => sum + doc.markdown.length, 0);
  if (chars > 60000) reject("CONTEXT_TOO_LONG", "资料超过 6 万字符，请减少篇数后分次阅读。本次未发送模型。");
  return { docs, guide: READING_GUIDE, fingerprint: digest([GUIDE_VERSION, docs.map(doc => [doc.itemId, doc.version])]), batches: splitDocuments(docs).length + 1, maxCalls: splitDocuments(docs).length * 2 + 1,
    manifest: { schema_version: "campus-markdown-v1", guide_version: GUIDE_VERSION, school_id: schoolId, documents: docs.map(({ markdown, ...meta }) => meta), context_chars: chars, generated_at: new Date().toISOString(), attachments: "not_read" } };
}
export interface Batch { kind: "source" | "merge"; content: string }
export function splitDocuments(docs: ReadingDocument[]): Batch[] {
  return docs.flatMap(doc => Array.from({ length: Math.ceil(doc.markdown.length / 5500) }, (_, index) => ({ kind: "source" as const, content: `资料 ${doc.reference} 第 ${index + 1}/${Math.ceil(doc.markdown.length / 5500)} 段（不是完整公告）：\n${doc.markdown.slice(index * 5500, (index + 1) * 5500)}` })));
}
export function mergeBatches(notes: string[]): Batch[] {
  const batches: Batch[] = [];
  for (const note of notes) {
    if (note.length > 5000) reject("OUTPUT_TRUNCATED", "分批笔记过长，请减少资料后重新阅读。");
    const last = batches[batches.length - 1];
    if (last && last.content.length + note.length + 2 <= 5500) last.content += `\n\n${note}`;
    else batches.push({ kind: "merge", content: note });
  }
  return batches;
}
export function verifyReferences(text: string, docs: ReadingDocument[]): string {
  const refs = new Set(docs.map(doc => doc.reference)), urls = new Set(docs.map(doc => doc.originalUrl).filter(Boolean));
  for (const match of text.matchAll(/\bR\d+\b/g)) if (!refs.has(match[0])) reject("REFERENCE_INVALID", "模型引用了未选中的资料，结果未采纳。");
  for (const match of text.matchAll(/\[(R\d+)\]\((https?:\/\/[^\s)]+)\)/g)) if (docs.find(doc => doc.reference === match[1])?.originalUrl !== match[2]) reject("REFERENCE_INVALID", "模型引用编号与原文不对应，结果未采纳。");
  for (const match of text.matchAll(/https?:\/\/[^\s<>\]）)"']+/g)) if (!urls.has(match[0])) reject("REFERENCE_INVALID", "模型输出了来源清单以外的网址，结果未采纳。");
  if (!/\bR\d+\b/.test(text)) reject("REFERENCE_INVALID", "模型未给出资料引用，结果未采纳。");
  return text;
}
