import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiMemoryItem } from '@campus/contracts';
import * as memory from '../src/assistant-memory';

const stamp = '2026-10-22T03:00:00.000Z';
const item = (id: string, slot: AiMemoryItem['slot'], text: string, goalId?: string): AiMemoryItem => ({ id, slot, text, createdAt: stamp, updatedAt: stamp, expiresAt: null, ...(goalId ? { goalId } : {}) });
test('relevant goal selection retains background and its own progress; general questions keep at most three goals', () => {
  const items = [item('major', 'major', '我是计算机专业'), item('g1', 'goal', '我准备考研'), item('p1', 'progress', '我已完成报名', 'g1'), item('g2', 'goal', '我准备申请实习'), item('p2', 'progress', '我已提交简历', 'g2'), item('g3', 'goal', '我准备参加蓝桥杯'), item('p3', 'progress', '我已进入复赛', 'g3')];
  assert.deepEqual(memory.selectMemoryItems(items, '实习要准备什么材料？').map(value => value.id), ['major', 'g2', 'p2']);
  assert.deepEqual(memory.selectMemoryItems(items, '最近有什么适合我？').map(value => value.id), ['major', 'g1', 'p1', 'g2', 'p2', 'g3', 'p3']);
  assert.deepEqual(memory.selectMemoryItems([item('progress', 'progress', '我已完成报名')], '最近有什么适合我？').map(value => value.id), ['progress']);
  assert.equal(memory.selectMemoryItems(items, '蓝桥杯什么时候报名？').some(value => value.id === 'g1'), false);
});
