import cloudbase from "@cloudbase/node-sdk";
import { reject } from "./errors";
export type Database = ReturnType<ReturnType<typeof cloudbase.init>["database"]>;
export type Transaction = Awaited<ReturnType<Database["startTransaction"]>>;
export async function readDoc(db: Database, collection: string, id: string): Promise<Record<string, any> | null> {
  try {
    const { data } = await db.collection(collection).where({ _id: id }).limit(1).get();
    return data[0] || null;
  } catch (error) {
    if ((error as { code?: string })?.code === "DATABASE_COLLECTION_NOT_EXIST")
      reject("COLLECTION_REQUIRED", `请新建空集合 ${collection}，权限设为仅管理端读写。`);
    throw error;
  }
}
export async function seed(db: Database, collection: string, id: string, row: Record<string, unknown>) {
  if (await readDoc(db, collection, id)) return;
  try { await db.collection(collection).add({ _id: id, ...row }); }
  catch (error) { if (!await readDoc(db, collection, id)) throw error; }
}
export async function atomic<T>(db: Database, run: (tx: Transaction) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const tx = await db.startTransaction();
    try { const value = await run(tx); await tx.commit(); return value; }
    catch (error) {
      await tx.rollback().catch(() => {});
      if (attempt < 3 && /conflict|transaction.*(abort|retry)/i.test(String((error as {code?: unknown})?.code || "") + String((error as Error)?.message || ""))) continue;
      throw error;
    }
  }
}
export function transactionRow(data: unknown): Record<string, any> {
  return (Array.isArray(data) ? data[0] : data) || {};
}
