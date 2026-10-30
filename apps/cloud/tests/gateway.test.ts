import assert from "node:assert/strict";
import { test } from "node:test";
import { createGateway, originalUrl } from "../src/gateway";
import { identify } from "../src/identity";
import { itemVisible, sourceVisible, type Scope } from "../src/scope";
import type { ItemRow, Repository } from "../src/repository";
import type { School } from "@campus/contracts";

const caller = { uid: "verified-owner", isAnonymous: false };
const config = { ownerUid: caller.uid };
const identity = identify(caller, config);
const school: School = { id: "bjtu", name: "北京交通大学", status: "ready" };
const scope: Scope = {
  schoolId: "bjtu",
  ownerId: identity.dataOwnerId,
  publicSourceIds: ["public-source"],
  privateSourceIds: ["legacy-mail"],
};
const now = Date.parse("2026-10-15T12:00:00Z");
const notice: ItemRow = {
  _id: "one",
  scope: "school",
  schoolIds: ["bjtu"],
  title: "测试公告，仅限回归测试",
  contentText: "<script>doNotRun()</script>",
  status: "published",
  publishedAt: "2026-10-14T00:00:00Z",
  originalUrl: "https://www.bjtu.edu.cn/a",
};
function fixture(changes: Partial<Repository> = {}) {
  let selected: string | null = "bjtu";
  let reads = 0;
  const repo: Repository = {
    async selectedSchool() {
      reads++;
      return selected;
    },
    async school(id) {
      reads++;
      return id === "bjtu" ? school : null;
    },
    async schools() {
      reads++;
      return [school];
    },
    async selectSchool(_owner, id) {
      selected = id;
    },
    async scope() {
      reads++;
      return scope;
    },
    async items() {
      reads++;
      return [notice];
    },
    async item(id) {
      reads++;
      return id === notice._id ? notice : null;
    },
    ...changes,
  };
  return {
    repo,
    reads: () => reads,
    gateway: createGateway(repo, config, () => now),
  };
}
function code(value: { ok: boolean; code?: string }): string | undefined {
  return value.code;
}

test('brief status reads the authorized cache without material fetching, selection changes or model work',async()=>{
 let material=0,brief=0;const f=fixture({material:async row=>{material++;return row;},brief:async()=>{brief++;return{state:'pending',attachmentsRead:false,checkedAt:new Date(now).toISOString()};}});
 const result=await f.gateway({action:'feed.brief',input:{schoolId:'bjtu',itemId:'one'}},caller);assert.equal(result.ok,true);assert.equal(brief,1);assert.equal(material,0);
 assert.equal((await f.gateway({action:'feed.brief',input:{schoolId:'other',itemId:'one'}},caller)).ok,false);assert.equal(brief,1);
 assert.equal((await f.gateway({action:'feed.brief',input:{schoolId:'bjtu',itemId:'one',owner:'forged'}},caller)).ok,false);
});
test('a broken cache cannot hide or rewrite the original article',async()=>{
 const f=fixture({brief:async()=>{throw Error('private database details');}});const result=await f.gateway({action:'feed.detail',input:{schoolId:'bjtu',itemId:'one'}},caller);assert.equal(result.ok,true);if(result.ok){const detail=result.data as import('@campus/contracts').NoticeDetail;assert.equal(detail.title,notice.title);assert.equal(detail.text,notice.contentText);assert.equal(detail.brief?.state,'failed');assert.ok(!JSON.stringify(detail).includes('private database'));}
});

test("anonymous and logged-out requests never touch the database", async () => {
  const f = fixture();
  for (const actor of [
    { uid: "", isAnonymous: false },
    { uid: caller.uid, isAnonymous: true },
  ]) {
    assert.equal(
      code(await f.gateway({ action: "session.get" }, actor)),
      "UNAUTHENTICATED",
    );
  }
  assert.equal(f.reads(), 0);
});
test("another authenticated UID cannot self-claim the workspace", async () => {
  const f = fixture();
  assert.equal(
    code(
      await f.gateway(
        { action: "session.get" },
        { uid: "other", isAnonymous: false },
      ),
    ),
    "FORBIDDEN",
  );
  assert.equal(f.reads(), 0);
});
test("missing owner configuration rejects rather than adopting the first visitor", async () => {
  const f = fixture();
  assert.equal(
    code(await createGateway(f.repo, {})({ action: "session.get" }, caller)),
    "OWNER_NOT_CONFIGURED",
  );
  assert.equal(f.reads(), 0);
});
test("client-provided identities, functions, and privileged actions are rejected", async () => {
  const f = fixture();
  const bad = [
    { action: "session.get", uid: caller.uid },
    { action: "session.get", ownerOpenid: "old-owner" },
    { action: "session.get", input: { OPENID: "old-owner" } },
    { action: "feed.list", input: { schoolId: "bjtu", owner: "old-owner" } },
    { action: "__proto__" },
    { action: "constructor" },
    { action: "initDatabase" },
    { action: "privateBind" },
    { action: "callFunction", input: { name: "mailFetch" } },
  ];
  for (const event of bad)
    assert.equal((await f.gateway(event, caller)).ok, false);
  assert.equal(f.reads(), 0);
});
test("CloudBase transport metadata is ignored and cannot override server identity", async () => {
  const f = fixture();
  const event = {
    action: "session.get",
    input: {},
    userInfo: { uid: "forged-owner", openId: "old-owner", isAnonymous: false },
    tcbContext: { uid: "forged-owner", OPENID: "old-owner" },
  };
  const result = await f.gateway(event, caller);
  assert.equal(result.ok, true);
  if (result.ok)
    assert.equal((result.data as { identity: { uid: string } }).identity.uid, caller.uid);
  const reads = f.reads();
  for (const actor of [
    { uid: "", isAnonymous: false },
    { uid: caller.uid, isAnonymous: true },
    { uid: "other", isAnonymous: false },
  ]) {
    assert.equal((await f.gateway({ ...event, userInfo: caller, tcbContext: caller }, actor)).ok, false);
  }
  assert.equal(f.reads(), reads);
  assert.equal(code(await f.gateway({ action: "session.get", input: { userInfo: caller } }, caller)), "VALIDATION_FAILED");
  assert.equal(code(await f.gateway({ action: "session.get", input: { tcbContext: caller } }, caller)), "VALIDATION_FAILED");
});
test("Web identity is distinct by default, server-only linking retains the legacy key", () => {
  assert.notEqual(identity.dataOwnerId, caller.uid);
  assert.equal(identity.legacyLinked, false);
  const linked = identify(caller, {
    ...config,
    legacyOpenid: "verified-old-owner",
  });
  assert.equal(linked.dataOwnerId, "verified-old-owner");
  assert.equal(linked.legacyLinked, true);
});
test("session reads existing school but does not select, initialize, or bind anything", async () => {
  const f = fixture({
    async selectSchool() {
      throw new Error("unexpected write");
    },
  });
  const result = await f.gateway({ action: "session.get", input: {} }, caller);
  assert.equal(result.ok, true);
  if (result.ok)
    assert.deepEqual((result.data as { school: School }).school, school);
});
test("first Web login does not silently select BJTU or inherit another profile", async () => {
  const f = fixture({
    async selectedSchool(owner) {
      assert.equal(owner, identity.dataOwnerId);
      return null;
    },
  });
  const result = await f.gateway({ action: "session.get" }, caller);
  assert.equal(result.ok, true);
  if (result.ok)
    assert.equal((result.data as { school: unknown }).school, null);
});
test("school selection only saves a catalog school for the verified owner", async () => {
  let saved = false;
  const f = fixture({
    async selectSchool(owner, id) {
      assert.equal(owner, identity.dataOwnerId);
      assert.equal(id, "bjtu");
      saved = true;
    },
  });
  assert.equal(
    (
      await f.gateway(
        { action: "school.select", input: { schoolId: "bjtu" } },
        caller,
      )
    ).ok,
    true,
  );
  assert.equal(saved, true);
  assert.equal(
    code(
      await f.gateway(
        { action: "school.select", input: { schoolId: "invented" } },
        caller,
      ),
    ),
    "SCHOOL_NOT_FOUND",
  );
});
test("stale school requests are rejected, including direct detail IDs", async () => {
  const f = fixture({
    async selectedSchool() {
      return "other-school";
    },
  });
  for (const action of ["feed.list", "feed.detail"]) {
    assert.equal(
      code(
        await f.gateway(
          {
            action,
            input: {
              schoolId: "bjtu",
              ...(action === "feed.detail" ? { itemId: "one" } : {}),
            },
          },
          caller,
        ),
      ),
      "STALE_SCOPE",
    );
  }
});
test("other school, private mail without owner, and withdrawn items return indistinguishable NOT_FOUND", async () => {
  for (const patch of [
    { schoolIds: ["elsewhere"] },
    { scope: "private" },
    { category: "mail" },
    { categories: ["activity", "mail"] },
    { ownerOpenid: "other-owner" },
    { scope: undefined, sourceId: "legacy-mail" },
    { status: "withdrawn" },
    { publishedAt: "2025-10-14T00:00:00Z" },
  ]) {
    const f = fixture({
      async item() {
        return { ...notice, ...patch };
      },
    });
    assert.equal(
      code(
        await f.gateway(
          { action: "feed.detail", input: { schoolId: "bjtu", itemId: "one" } },
          caller,
        ),
      ),
      "NOT_FOUND",
    );
  }
});
test("a faulty repository cannot leak unauthorized rows through feed pagination", async () => {
  const f = fixture({
    async items() {
      return [{ ...notice, schoolIds: ["elsewhere"] }];
    },
  });
  const result = await f.gateway(
    { action: "feed.list", input: { schoolId: "bjtu" } },
    caller,
  );
  assert.equal(code(result), "SCOPE_CHECK_FAILED");
  assert.equal("data" in result, false);
});
test("listing uses bounded DB pagination and does not emit full text or raw ownership fields", async () => {
  const rows = Array.from({ length: 21 }, (_, i) => ({
    ...notice,
    _id: `notice-${i}`,
  }));
  const f = fixture({
    async items(_scope, offset, limit) {
      assert.equal(offset, 20);
      assert.equal(limit, 21);
      return rows;
    },
  });
  const result = await f.gateway(
    { action: "feed.list", input: { schoolId: "bjtu", cursor: "20" } },
    caller,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    const data = result.data as {
      items: Record<string, unknown>[];
      nextCursor: string;
    };
    assert.equal(data.items.length, 20);
    assert.equal(data.nextCursor, "40");
    assert.equal("contentText" in data.items[0], false);
    assert.equal("schoolIds" in data.items[0], false);
  }
});
test("invalid cursors and non-string IDs are rejected", async () => {
  const f = fixture();
  for (const cursor of [-1, "NaN", "100001", "1.5", {}, "0 OR 1=1"]) {
    assert.equal(
      code(
        await f.gateway(
          { action: "feed.list", input: { schoolId: "bjtu", cursor } },
          caller,
        ),
      ),
      "VALIDATION_FAILED",
    );
  }
});
test("search reaches repository pagination with authorized scope and is independently checked", async () => {
  let queried = false;
  const f = fixture({ async items(actualScope, offset, limit, since, filters) {
    assert.equal(actualScope.ownerId, identity.dataOwnerId);
    assert.equal(offset, 20);
    assert.equal(limit, 21);
    assert.equal(since, new Date(now - 7 * 86400000).toISOString());
    assert.deepEqual(filters, { keyword: "测试", categories: ["competition"], period: "7d" });
    queried = true;
    return [{ ...notice, categories: ["school", "competition"] }];
  } });
  const result = await f.gateway({ action: "feed.list", input: { schoolId: "bjtu", cursor: "20", keyword: "测试", categories: ["competition"], period: "7d" } }, caller);
  assert.equal(result.ok, true);
  assert.equal(queried, true);
  const faulty = fixture();
  assert.equal(code(await faulty.gateway({ action: "feed.list", input: { schoolId: "bjtu", keyword: "no-match" } }, caller)), "SCOPE_CHECK_FAILED");
});
test("unknown database errors never include secrets or silently return an empty success", async () => {
  const f = fixture({
    async items() {
      throw new Error("token=secret-password private-mail-body");
    },
  });
  const result = await f.gateway(
    { action: "feed.list", input: { schoolId: "bjtu" } },
    caller,
  );
  assert.equal(code(result), "SERVICE_UNAVAILABLE");
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret-password|private-mail-body/,
  );
});
test("source and item rules isolate unbound legacy private records even under public metadata", () => {
  assert.equal(
    sourceVisible({ key: "bjtu-tzgg" }, "bjtu", identity.dataOwnerId),
    true,
  );
  assert.equal(
    sourceVisible({ key: "bjtu-tzgg" }, "elsewhere", identity.dataOwnerId),
    false,
  );
  assert.equal(
    sourceVisible({ key: "mail-inbox" }, "bjtu", identity.dataOwnerId),
    false,
  );
  assert.equal(
    itemVisible({ scope: "global", sourceId: "legacy-mail" }, scope),
    false,
  );
  assert.equal(
    itemVisible({ scope: "global", canonicalUrl: "mail:123" }, scope),
    false,
  );
  assert.equal(
    itemVisible({ scope: "private", ownerOpenid: identity.dataOwnerId }, scope),
    true,
  );
});
test("only full HTTP(S) original URLs without credentials are exposed", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://user:password@example.com/",
    "/relative",
  ])
    assert.equal(originalUrl({ ...notice, originalUrl: value }), null);
  assert.equal(originalUrl({ ...notice, canonicalUrl: "mail:1" }), null);
  assert.equal(originalUrl({ ...notice, canonicalUrl: "manual:1" }), "https://www.bjtu.edu.cn/a");
  assert.equal(originalUrl(notice), "https://www.bjtu.edu.cn/a");
});
