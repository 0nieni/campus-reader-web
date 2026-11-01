import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { AiChatTurn, AiConversation } from '@campus/contracts';
import { assistantChat } from '../src/assistant-chat';
import { aiService } from '../src/ai-service';
import { fixtureDb, identity } from './feature-fixture';

test('final conversation invocation receives the complete style policy from Markdown with real user context, not the old report guide', async () => {
  const f = fixtureDb(), invocations: Array<{ guide: string; content: string }> = [];
  process.env.AI_CHAT_BASE_URL = 'https://api.deepseek.com'; process.env.AI_CHAT_MODEL = 'fixture-model'; process.env.AI_CHAT_API_KEY = 'fixture-key'; process.env.AI_EXECUTION_MODE = 'direct';
  f.rows('user_profiles').get(identity.dataOwnerId)!.aiAssistant = { bjtu: { preferences: { interests: ['编程'], goals: '积累项目经验' } } };
  const ai = aiService(f.db, f.repo, async (_connection, guide, content) => {
    invocations.push({ guide, content });
    return '需要报名材料。[R1](https://www.bjtu.edu.cn/test)';
  });
  const chat = assistantChat(f.db, f.repo, ai, async () => ({ items: [], search: { state: 'idle', message: '' }, coverage: '' }));
  const c = await chat.handle('ai.chat.create', { schoolId: 'bjtu', requestId: 'style-conversation-0001' }, identity) as AiConversation;
  let t = await chat.handle('ai.chat.send', { conversationId: c.id, requestId: 'style-turn-00000001', question: '只说要交什么，不用给建议', itemIds: ['notice'] }, identity) as AiChatTurn;
  while (t.state === 'ready') t = await chat.handle('ai.chat.step', { conversationId: c.id, turnId: t.id, step: t.step }, identity) as AiChatTurn;
  assert.equal(t.state, 'complete');
  const markdown = readFileSync(new URL('../../../docs/ai-reading-guide.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const expected = markdown.split('## 模型任务指令\n')[1]!.split('## 软件接入约定')[0]!.trim();
  const final = invocations[invocations.length - 1]!;
  assert.equal(final.guide, expected, 'the entire instruction block, including examples, must reach the final model call');
  assert.ok(final.guide.includes('你是我的个人助手') && final.guide.includes('先问我这一个问题'), 'the user-supplied role and clarification policy reach the real final invocation');
  assert.ok(final.guide.includes('不附后续建议'), 'the final model receives the refusal/brief-answer stop condition');
  assert.ok(final.content.includes('积累项目经验') && final.content.includes('只说要交什么，不用给建议'));
  assert.ok(!final.content.includes('七节结构保持完整'));
  assert.ok(!final.guide.includes('软件接入约定') && !final.guide.includes('当前尚未部署'));
  assert.equal((await ai.handle('ai.status', {}, identity) as any).quota.used, 1);
});
