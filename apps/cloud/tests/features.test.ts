import assert from "node:assert/strict";
import { test } from "node:test";
import { aiService, beijingDay, dailyLimit } from "../src/ai-service";
import { bookmarksService } from "../src/bookmarks";
import { createGateway } from "../src/gateway";
import { digest, readingPackage, verifyReferences } from "../src/reading-package";
import { validateConnection, publicAddress } from "../src/model-provider";
import { fixtureDb, actor, ownerConfig, identity } from "./feature-fixture";
import type { ReadingTask } from "@campus/contracts";
import { READING_GUIDE } from '../src/reading-guide';
import { BATCH_READING_GUIDE, BATCH_OUTPUT_TOKENS, FINAL_OUTPUT_TOKENS } from '../src/reading-batch-guide';

process.env.AI_CHAT_BASE_URL = "https://api.deepseek.com";
process.env.AI_CHAT_API_KEY = "test-server-key-never-real";
process.env.AI_CHAT_MODEL = "fixture-model";
process.env.AI_DAILY_LIMIT = "5";
delete process.env.AI_PROVIDER;
const start = (requestId = "request_abcdefghijkl", service = "official") => ({ schoolId: "bjtu", itemIds: ["notice"], requestId, service, task: "summary", ...(service === "byok" ? { provider: "deepseek", model: "fixture-model" } : {}) });
const output = "报名材料见资料。[R1](https://www.bjtu.edu.cn/test)";
const connection = { provider: "deepseek", model: "fixture-model", apiKey: "test-transient-key-never-real" };

test('official diagnosis requires the owner and does not reserve quota, create tasks or call a model', async () => {
  const f = fixtureDb(); let checks = 0, completions = 0;
  const ai = aiService(f.db, f.repo, async () => { completions++; return output; }, Date.now, async () => { checks++; return { code: 'READY', message: 'checked' }; });
  const gateway = createGateway(f.repo, ownerConfig, Date.now, { ai });
  assert.equal((await gateway({ action: 'ai.diagnose', input: {} }, { uid: 'stranger', isAnonymous: false })).ok, false);
  assert.equal((await gateway({ action: 'ai.diagnose', input: { endpoint: 'https://attacker.test' } }, actor)).ok, false);
  assert.equal(checks, 0);
  const result = await gateway({ action: 'ai.diagnose', input: {} }, actor);
  assert.deepEqual(result, { ok: true, data: { code: 'READY', message: 'checked' } });
  assert.equal(checks, 1); assert.equal(completions, 0);
  assert.equal(f.rows('web_ai_tasks').size, 0); assert.equal(f.rows('web_ai_accounts').size, 0);
});

test('definite model errors preserve safe reasons on refresh and release holds without replaying', async () => {
  for (const code of ['KEY_REJECTED', 'BALANCE_REQUIRED', 'MODEL_OR_CONTEXT_INVALID', 'MODEL_UNSUPPORTED', 'OUTPUT_TRUNCATED', 'PROVIDER_CONTENT_FILTER', 'PROVIDER_INTERRUPTED', 'MODEL_FORMAT_INVALID']) {
    const f = fixtureDb(); let calls = 0;
    const ai = aiService(f.db, f.repo, async () => { calls++; throw Object.assign(new Error('provider-body-fixture-private-key'), { code }); });
    const task = await ai.handle('ai.start', start(), identity) as ReadingTask;
    const failed = await ai.handle('ai.step', { taskId: task.id, step: 0 }, identity) as ReadingTask;
    assert.equal(failed.state, 'failed'); assert.equal(failed.failureCode, code); assert.equal(failed.quotaHeld, false);
    assert.ok(!JSON.stringify(failed).includes('provider-body-fixture-private-key'));
    assert.ok(!failed.message.includes('模型未完成本批，请检查 Key、余额、模型或资料范围'));
    const restored = await ai.handle('ai.task', { taskId: task.id }, identity) as ReadingTask;
    assert.equal(restored.failureCode, code); assert.equal(restored.message, failed.message);
    await ai.handle('ai.step', { taskId: task.id, step: 0 }, identity); assert.equal(calls, 1);
    const q = (await ai.handle('ai.status', {}, identity) as any).quota;
    assert.deepEqual([q.used, q.held, q.remaining], [0, 0, 3]);
  }
});

test('intermediate calls use compact notes, final calls retain the full guide, and platform estimates cover each output cap', async () => {
  const f = fixtureDb(); const sent: Array<{ guide: string; body: string; tokens: number }> = [];
  const ai = aiService(f.db, f.repo, async (_connection, guide, body, tokens) => { sent.push({ guide, body, tokens: tokens! }); return output; });
  const task = await ai.handle('ai.start', start('request_compact_notes_v2'), identity) as ReadingTask;
  const note = await ai.handle('ai.step', { taskId: task.id, step: 0 }, identity) as ReadingTask;
  assert.equal(note.state, 'ready'); assert.equal(note.step, 1);
  assert.equal(sent[0]!.guide, BATCH_READING_GUIDE); assert.notEqual(sent[0]!.guide, READING_GUIDE);
  assert.match(sent[0]!.body, /350 字/); assert.doesNotMatch(sent[0]!.guide, /## 一、资料范围/);
  assert.match(sent[0]!.guide, /不执行/); assert.match(sent[0]!.guide, /不补年份/);
  assert.equal(sent[0]!.tokens, BATCH_OUTPUT_TOKENS);
  const final = await ai.handle('ai.step', { taskId: task.id, step: 1 }, identity) as ReadingTask;
  assert.equal(final.state, 'complete'); assert.equal(sent[1]!.guide, READING_GUIDE);
  assert.equal(sent[1]!.tokens, FINAL_OUTPUT_TOKENS);
  const budget = [...f.rows('web_ai_accounts').values()].find(row => row.attempts !== undefined)!;
  assert.equal(budget.attempts, 2);
  assert.equal(budget.estimatedTokens, sent.reduce((sum, call) => sum + call.guide.length + call.body.length + call.tokens, 0));
  const quota = (await ai.handle('ai.status', {}, identity) as any).quota;
  assert.deepEqual([quota.used, quota.held], [1, 0]);
});

test("bookmarks are owner-scoped, idempotent, concurrent-safe and retain unrelated profile fields", async () => {
  const f = fixtureDb(), service = bookmarksService(f.db, f.repo);
  await Promise.all(Array.from({ length: 5 }, () => service.handle("favorites.set", { schoolId: "bjtu", itemId: "notice", saved: true }, identity)));
  assert.equal(f.rows("user_profiles").get(identity.dataOwnerId)!.webBookmarks.length, 1);
  assert.equal(f.rows("user_profiles").get(identity.dataOwnerId)!.unrelated, "preserve");
  assert.equal(await service.has(identity.dataOwnerId, "bjtu", "notice"), true);
  assert.deepEqual(await service.handle("favorites.list", {}, { ...identity, dataOwnerId: "another" }), { items: [], nextCursor: null });
  f.items.get("notice")!.status = "withdrawn";
  const list = await service.handle("favorites.list", {}, identity) as { items: Array<{ notice: unknown }> };
  assert.equal(list.items[0].notice, null);
  await service.handle("favorites.set", { schoolId: "bjtu", itemId: "notice", saved: false }, identity);
  assert.equal(await service.has(identity.dataOwnerId, "bjtu", "notice"), false);
});
test("bookmark gateway rejects forged ownership and cross-school additions", async () => {
  const f = fixtureDb(), bookmarks = bookmarksService(f.db, f.repo), gateway = createGateway(f.repo, ownerConfig, Date.now, { bookmarks });
  assert.equal((await gateway({ action: "favorites.list", input: { owner: "another" } }, actor)).ok, false);
  assert.equal((await gateway({ action: "favorites.set", input: { schoolId: "other", itemId: "notice", saved: true } }, actor)).ok, false);
  assert.equal(f.rows("user_profiles").get(identity.dataOwnerId)!.webBookmarks, undefined);
});
test("concurrent official requests cannot reserve more than three, duplicate request IDs reserve once", async () => {
  const f = fixtureDb(), ai = aiService(f.db, f.repo, async () => output);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => ai.handle("ai.start", start(`request_concurrent_${index}`), identity)));
  assert.equal(results.filter(value => value.status === "fulfilled").length, 3);
  for (const row of f.rows("web_ai_tasks").values()) if (row.state === "new") {
    assert.deepEqual(row.docs, []); assert.equal(row.question, "");
  }
  const status = await ai.handle("ai.status", {}, identity) as any;
  assert.deepEqual([status.quota.used, status.quota.held, status.quota.remaining], [0, 3, 0]);
  const one = fixtureDb(), ai2 = aiService(one.db, one.repo, async () => output);
  const repeated = await Promise.all(Array.from({ length: 5 }, () => ai2.handle("ai.start", start(), identity))) as ReadingTask[];
  assert.equal(new Set(repeated.map(task => task.id)).size, 1);
  assert.equal((await ai2.handle("ai.status", {}, identity) as any).quota.held, 1);
  await assert.rejects(ai2.handle("ai.start", { ...start(), task: "outline" }, identity), { code: "REQUEST_CONFLICT" });
});
test("official batch replay does not call the next step or double-charge final success", async () => {
  const f = fixtureDb(); let calls = 0;
  const ai = aiService(f.db, f.repo, async () => { calls++; return output; });
  const task = await ai.handle("ai.start", start(), identity) as ReadingTask;
  await ai.handle("ai.step", { taskId: task.id, step: 0 }, identity);
  await ai.handle("ai.step", { taskId: task.id, step: 0 }, identity);
  assert.equal(calls, 1);
  const done = await ai.handle("ai.step", { taskId: task.id, step: 1 }, identity) as ReadingTask;
  assert.equal(done.state, "complete"); assert.equal(done.result, output);
  await ai.handle("ai.step", { taskId: task.id, step: 1 }, identity);
  assert.equal(calls, 2);
  const quota = (await ai.handle("ai.status", {}, identity) as any).quota;
  assert.deepEqual([quota.used, quota.held, quota.remaining], [1, 0, 2]);
});
test("BYOK only passes its key to the current provider call and consumes no official quota", async () => {
  const f = fixtureDb(); let received = "";
  const ai = aiService(f.db, f.repo, async value => { received = value.apiKey; return output; });
  const task = await ai.handle("ai.start", start(undefined, "byok"), identity) as ReadingTask;
  await ai.handle("ai.step", { taskId: task.id, step: 0, connection }, identity);
  assert.equal(received, connection.apiKey);
  assert.doesNotMatch(JSON.stringify([...f.rows("web_ai_tasks").values(), ...f.rows("web_ai_accounts").values()]), /test-transient-key|test-server-key/);
  assert.equal((await ai.handle("ai.status", {}, identity) as any).quota.used, 0);
  await assert.rejects(ai.handle("ai.step", { taskId: task.id, step: 1 }, identity), { code: "KEY_INVALID" });
});
test("unknown model outcome pauses without retry or release; owner can settle after checking provider", async () => {
  const f = fixtureDb(); let calls = 0;
  const ai = aiService(f.db, f.repo, async () => { calls++; throw Object.assign(new Error("raw secret provider body"), { code: "MODEL_UNCERTAIN" }); });
  const task = await ai.handle("ai.start", start(), identity) as ReadingTask;
  const result = await ai.handle("ai.step", { taskId: task.id, step: 0 }, identity) as ReadingTask;
  assert.equal(result.state, "uncertain"); assert.equal(result.quotaHeld, true); assert.doesNotMatch(JSON.stringify(result), /raw secret/);
  await ai.handle("ai.step", { taskId: task.id, step: 0 }, identity); assert.equal(calls, 1);
  await ai.handle("ai.cancel", { taskId: task.id }, identity);
  assert.equal((await ai.handle("ai.status", {}, identity) as any).quota.held, 1);
  await ai.handle("ai.resolve", { taskId: task.id, charged: false }, identity);
  await ai.handle("ai.resolve", { taskId: task.id, charged: false }, identity);
  assert.equal((await ai.handle("ai.status", {}, identity) as any).quota.held, 0);
});
test("definite provider refusal releases the reservation, changed source policies never reach a model", async () => {
  const f = fixtureDb(); let calls = 0;
  const ai = aiService(f.db, f.repo, async () => { calls++; throw Object.assign(new Error("secret"), { code: "KEY_REJECTED" }); });
  const first = await ai.handle("ai.start", start(), identity) as ReadingTask;
  assert.equal((await ai.handle("ai.step", { taskId: first.id, step: 0 }, identity) as ReadingTask).state, "failed");
  assert.equal((await ai.handle("ai.status", {}, identity) as any).quota.held, 0);
  const second = await ai.handle("ai.start", start("request_second_abcdef"), identity) as ReadingTask;
  f.rows("sources").get("source")!.aiProcessing = "import_only";
  await assert.rejects(ai.handle("ai.step", { taskId: second.id, step: 0 }, identity), { code: "AI_POLICY_BLOCKED" });
  assert.equal(calls, 1);
  await ai.handle("ai.cancel", { taskId: second.id }, identity);
  assert.equal((await ai.handle("ai.status", {}, identity) as any).quota.held, 0);
});
test("Beijing rollover settles the original account and never returns expired task bodies", async () => {
  const f = fixtureDb(); let now = Date.parse("2026-10-15T15:59:59Z");
  const ai = aiService(f.db, f.repo, async () => output, () => now);
  const task = await ai.handle("ai.start", start(), identity) as ReadingTask;
  await ai.handle("ai.step", { taskId: task.id, step: 0 }, identity);
  now += 2000;
  await ai.handle("ai.step", { taskId: task.id, step: 1 }, identity);
  assert.equal(beijingDay(now), "2026-10-16");
  assert.equal(f.rows("web_ai_accounts").get(digest([identity.dataOwnerId, "2026-10-15"]))!.used, 1);
  assert.equal((await ai.handle("ai.status", {}, identity) as any).quota.used, 0);
  now = Date.parse(task.expireAt);
  await assert.rejects(ai.handle("ai.task", { taskId: task.id }, identity), { code: "RESULT_EXPIRED" });
  await assert.rejects(ai.handle("ai.start", start(), identity), { code: "RESULT_EXPIRED" });
  await ai.handle("ai.status", {}, identity);
  for (const key of ["docs", "notes", "batches", "question", "result"]) assert.equal(key in f.rows("web_ai_tasks").get(task.id)!, false);
});
test("import-only material can be manually exported but cannot be previewed for AI", async () => {
  const f = fixtureDb(); f.items.get("notice")!.aiProcessing = "import_only";
  await assert.rejects(readingPackage(f.db, f.repo, identity.dataOwnerId, "bjtu", ["notice"]), { code: "AI_POLICY_BLOCKED" });
  const pack = await readingPackage(f.db, f.repo, identity.dataOwnerId, "bjtu", ["notice"], false);
  assert.equal(pack.docs.length, 1);
  assert.throws(() => verifyReferences("R2", pack.docs), { code: "REFERENCE_INVALID" });
  assert.throws(() => verifyReferences("[R1](https://evil.example/)", pack.docs), { code: "REFERENCE_INVALID" });
  assert.throws(() => validateConnection({ ...connection, provider: "__proto__" } as any), { code: "UNSUPPORTED_PROVIDER" });
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "192.168.1.1"]) assert.equal(publicAddress(ip), false);
});
test("API connection test is idempotent and contains neither announcement bodies nor official calls", async () => {
  const f = fixtureDb(); let calls = 0;
  const ai = aiService(f.db, f.repo, async (_connection, guide, body, tokens) => { calls++; assert.equal(tokens, 64); assert.doesNotMatch(guide + body, /测试竞赛|报名材料/); return "连接成功"; });
  const input = { schoolId: "bjtu", requestId: "request_connection_test", provider: "deepseek", model: "fixture-model" };
  const task = await ai.handle("ai.test", input, identity) as ReadingTask;
  await ai.handle("ai.step", { taskId: task.id, step: 0, connection }, identity);
  await ai.handle("ai.step", { taskId: task.id, step: 0, connection }, identity);
  assert.equal(calls, 1); assert.equal((await ai.handle("ai.status", {}, identity) as any).quota.held, 0);
});
test("concurrent steps and cancellation cannot duplicate provider work or resurrect results", async () => {
  const f = fixtureDb(); let calls = 0, resolve!: (text: string) => void, entered!: () => void;
  const waiting = new Promise<void>(r => { entered = r; });
  const ai = aiService(f.db, f.repo, async () => { calls++; entered(); return new Promise<string>(r => { resolve = r; }); });
  const task = await ai.handle("ai.start", start(), identity) as ReadingTask;
  const running = ai.handle("ai.step", { taskId: task.id, step: 0 }, identity); await waiting;
  assert.equal((await ai.handle("ai.step", { taskId: task.id, step: 0 }, identity) as ReadingTask).state, "running");
  await ai.handle("ai.cancel", { taskId: task.id }, identity);
  resolve(output); const result = await running as ReadingTask;
  assert.equal(result.state, "cancelled"); assert.equal(result.result, null); assert.equal(calls, 1);
  assert.deepEqual([(await ai.handle("ai.status", {}, identity) as any).quota.used, (await ai.handle("ai.status", {}, identity) as any).quota.held], [0, 0]);
});
test("a preview version cannot silently change, and missing official settings never yield mock results", async () => {
  const f = fixtureDb(), ai = aiService(f.db, f.repo, async () => output);
  const pack = await readingPackage(f.db, f.repo, identity.dataOwnerId, "bjtu", ["notice"]);
  f.items.get("notice")!.contentText = "正文已更改";
  await assert.rejects(ai.handle("ai.start", { ...start(), fingerprint: pack.fingerprint }, identity), { code: "MATERIAL_CHANGED" });
  const key = process.env.AI_CHAT_API_KEY; delete process.env.AI_CHAT_API_KEY;
  try {
    assert.equal((await ai.handle("ai.status", {}, identity) as any).officialConfigured, false);
    await assert.rejects(ai.handle("ai.start", start(), identity), { code: "MODEL_NOT_CONFIGURED" });
    assert.equal(f.rows("web_ai_tasks").size, 0);
  } finally { process.env.AI_CHAT_API_KEY = key; }
});
test("nonshrinking summaries stop at the declared call budget instead of creating an unlimited merge loop", async () => {
  const f = fixtureDb(); f.items.get("notice")!.contentText = "资料".repeat(12000);
  let calls = 0;
  const ai = aiService(f.db, f.repo, async () => { calls++; return "R1 " + "笔记".repeat(2250); });
  let task = await ai.handle("ai.start", start(undefined, "byok"), identity) as ReadingTask;
  const firstBatches = task.totalSteps - 1;
  while (task.state === "ready") task = await ai.handle("ai.step", { taskId: task.id, step: task.step, connection }, identity) as ReadingTask;
  assert.equal(task.state, "failed"); assert.equal(calls, firstBatches); assert.ok(calls <= firstBatches * 2 + 1);
});

 test('official daily quota is three even with the former hosted setting, and resets by Beijing date',()=>{
  assert.equal(dailyLimit(),3);
  assert.equal(beijingDay(Date.parse('2026-10-18T15:59:59Z')),'2026-10-18');
  assert.equal(beijingDay(Date.parse('2026-10-18T16:00:00Z')),'2026-10-19');
 });
