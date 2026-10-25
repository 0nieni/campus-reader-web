import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryOutput } from '../src/memory-output';

test('memory protocol separates the answer from a bounded candidate envelope', () => {
  const parsed = memoryOutput('直接答案。[R1](https://example.invalid/a)\n<!--campus-memory {"items":[{"slot":"major","text":"我是计算机专业","evidence":"我是计算机专业"}]} -->');
  assert.equal(parsed.answer, '直接答案。[R1](https://example.invalid/a)');
  assert.equal(parsed.proposals.length, 1);
});

test('invalid, unclosed, oversized or repeated hidden blocks never become public answer text or saved proposals', () => {
  for (const extra of ['<!--campus-memory nope -->', '<!--campus-memory {"items":[]} ', '<!--campus-memory '+ 'x'.repeat(3000)+' -->', '<!--campus-memory {"items":[]} --><!--campus-memory {"items":[]} -->', '<!-- campus-memory {"items":[]} -->', '<!--CAMPUS-MEMORY {"items":[]} -->']) {
    const parsed = memoryOutput('正常答案。[R1]\n' + extra);
    assert.equal(parsed.answer, '正常答案。[R1]');
    assert.deepEqual(parsed.proposals, []);
  }
});
