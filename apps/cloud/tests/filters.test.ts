import assert from "node:assert/strict";
import { test } from "node:test";
import { filtersOf, filterSince, literalPattern, matchesFilters } from "../src/filters";

test("keywords are literal text, including regex syntax and Chinese punctuation", () => {
  for (const keyword of ["C++", "[S1]", "a.*b", "(报名)", "a\\b", "^$?|"]) {
    const pattern = new RegExp(literalPattern(keyword), "i");
    assert.equal(pattern.test(`通知 ${keyword} 公告`), true);
    if (keyword === "a.*b") assert.equal(pattern.test("axyb"), false);
  }
  assert.equal(matchesFilters({ _id: "x", contentText: "欢迎学习 C++" }, { keyword: "c++" }), true);
  assert.equal(matchesFilters({ _id: "x", summary: { oneLine: "竞赛报名" } }, { keyword: "报名" }), true);
});
test("category matching uses any selected category, including multi-category notices", () => {
  assert.equal(matchesFilters({ _id: "x", categories: ["school", "competition"] }, { categories: ["activity", "competition"] }), true);
  assert.equal(matchesFilters({ _id: "x", category: "activity" }, { categories: ["activity"] }), true);
  assert.equal(matchesFilters({ _id: "x", category: "mail" }, { categories: ["competition"] }), false);
});
test("filter validation rejects malformed and unbounded inputs before querying", () => {
  for (const input of [{ keyword: {} }, { keyword: "a".repeat(101) }, { keyword: "a\nb" }, { categories: "mail" }, { categories: ["private"] }, { period: {} }, { period: ["7d"] }, { period: "1y" }])
    assert.throws(() => filtersOf(input), { code: "VALIDATION_FAILED" });
  assert.deepEqual(filtersOf({ keyword: "  比赛  ", categories: ["competition", "competition"], period: "7d" }), { keyword: "比赛", categories: ["competition"], period: "7d" });
});
test("time filters retain the 365-day maximum instead of broadening access", () => {
  const now = Date.parse("2026-10-15T16:00:00Z");
  for (const [period, days] of [["7d", 7], ["30d", 30], ["90d", 90], ["all", 365]] as const)
    assert.equal(Date.parse(filterSince({ period }, now)), now - days * 86400000);
});
