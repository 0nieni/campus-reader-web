import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

test('guide check accepts a Windows CRLF checkout without rewriting either source or generated guide', () => {
  const tempRoot = resolve(tmpdir()), sandbox = mkdtempSync(join(tempRoot, 'campus-guide-check-'));
  const source = new URL('../../../', import.meta.url);
  try {
    for (const path of ['tools/sync-ai-guide.mjs', 'docs/ai-reading-guide.md', 'apps/cloud/src/chat-guide.ts']) {
      const target = join(sandbox, path); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(new URL(path, source), 'utf8').replace(/\r?\n/g, '\r\n'));
    }
    const md = join(sandbox, 'docs/ai-reading-guide.md'), guide = join(sandbox, 'apps/cloud/src/chat-guide.ts');
    const beforeMd = readFileSync(md), beforeGuide = readFileSync(guide);
    execFileSync(process.execPath, [join(sandbox, 'tools/sync-ai-guide.mjs'), '--check'], { encoding: 'utf8' });
    assert.deepEqual(readFileSync(md), beforeMd); assert.deepEqual(readFileSync(guide), beforeGuide);
  } finally {
    // Delete only the verified, unique directory created by this test.
    if (dirname(sandbox) !== tempRoot || !basename(sandbox).startsWith('campus-guide-check-')) throw new Error('Unsafe test directory');
    rmSync(sandbox, { recursive: true, force: true });
  }
});
