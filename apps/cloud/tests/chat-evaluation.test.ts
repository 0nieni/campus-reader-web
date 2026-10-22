import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

test('dry-run evaluates all synthetic scenarios without provider calls and never claims a language score', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/evaluate-ai-chat.ts', '--dry-run'], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const summary = JSON.parse(result.stdout.trim());
  assert.equal(summary.cases, 8); assert.equal(summary.providerCalls, 0);
  const report = JSON.parse(readFileSync(summary.output, 'utf8'));
  assert.equal(report.halted, false); assert.equal(report.languageReview, 'pending');
  assert.ok(report.records.every((record: any) => record.turns.length > 0 && record.humanScore === null));
});

test('live evaluation without server credentials refuses before making requests', () => {
  const env = { ...process.env };
  for (const name of ['AI_CHAT_BASE_URL', 'AI_CHAT_MODEL', 'AI_CHAT_API_KEY']) delete env[name];
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/evaluate-ai-chat.ts', '--live'], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /未发起请求/);
  assert.ok(!result.stdout.includes('providerCalls'));
});
