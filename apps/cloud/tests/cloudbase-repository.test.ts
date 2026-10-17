import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudRepository } from "../src/cloudbase-repository";
import { createGateway } from "../src/gateway";

test("missing profile collection reports setup needed without creating data or returning empty success", async () => {
  let reads = 0;
  const query = {
    where() { return query; },
    limit() { return query; },
    async get() { reads++; throw { code: "DATABASE_COLLECTION_NOT_EXIST", message: "private SDK details" }; },
  };
  const db = {
    command: {},
    collection(name: string) { assert.equal(name, "user_profiles"); return query; },
  } as unknown as Parameters<typeof cloudRepository>[0];
  const result = await createGateway(cloudRepository(db), { ownerUid: "owner" })({ action: "session.get", tcbContext: {} }, { uid: "owner", isAnonymous: false });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "COLLECTION_REQUIRED");
    assert.match(result.message, /user_profiles/);
    assert.doesNotMatch(result.message, /private SDK details/);
  }
  assert.equal(reads, 1);
});

test("existing empty profiles are a valid first visit, other DB failures remain failures", async () => {
  let failure = false;
  const query = {
    where() { return query; },
    limit() { return query; },
    async get() { if (failure) throw { code: "DATABASE_PERMISSION_DENIED" }; return { data: [] }; },
  };
  const db = { command: {}, collection() { return query; } } as unknown as Parameters<typeof cloudRepository>[0];
  const repo = cloudRepository(db);
  assert.equal(await repo.selectedSchool("owner"), null);
  failure = true;
  await assert.rejects(repo.selectedSchool("owner"), { code: "DATABASE_PERMISSION_DENIED" });
});
