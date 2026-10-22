import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AiChatTurn, AiConversation } from '../packages/contracts/src/index';
import { aiService, officialConfig } from '../apps/cloud/src/ai-service';
import { assistantChat } from '../apps/cloud/src/assistant-chat';
import { userCompletion } from '../apps/cloud/src/model-provider';
import { fixtureDb, identity } from '../apps/cloud/tests/feature-fixture';
import { chatCases, evaluationMaterials } from '../apps/cloud/evals/chat-cases';

// A development-only CLI: synthetic, isolated in-memory DB; never site data.
const live = process.argv.includes('--live');
const selected = process.argv.find(value => value.startsWith('--case='))?.slice(7);
const cases = chatCases.filter(item => !selected || item.id === selected);
if (!cases.length || process.argv.some(value => value.startsWith('--') && !['--live', '--dry-run'].includes(value) && !value.startsWith('--case=')) || live && process.argv.includes('--dry-run')) {
  console.error('Usage: tsx tools/evaluate-ai-chat.ts [--dry-run | --live] [--case=continuity]');
  process.exit(2);
}
if (live && !officialConfig()) {
  console.error('真实模型未配置：请通过服务端环境提供 AI_CHAT_BASE_URL、AI_CHAT_MODEL、AI_CHAT_API_KEY。未发起请求。');
  process.exit(2);
}
const configKeys = ['AI_CHAT_BASE_URL', 'AI_CHAT_MODEL', 'AI_CHAT_API_KEY', 'AI_EXECUTION_MODE'] as const;
const previous = Object.fromEntries(configKeys.map(key => [key, process.env[key]]));
if (!live) {
  process.env.AI_CHAT_BASE_URL = 'https://api.deepseek.com'; process.env.AI_CHAT_MODEL = 'evaluation-dry-run'; process.env.AI_CHAT_API_KEY = 'synthetic-never-sent';
}
process.env.AI_EXECUTION_MODE = 'direct';
let calls = 0, halted = false;
const records: Array<Record<string, unknown>> = [];
const outputDir = resolve('output/ai-evaluation');
mkdirSync(outputDir, { recursive: true });
const output = resolve(outputDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${live ? 'live' : 'dry-run'}.json`);
const save = () => writeFileSync(output, JSON.stringify({ mode: live ? 'live' : 'dry-run', syntheticDataOnly: true, languageReview: 'pending', providerCalls: live ? calls : 0, simulatedCalls: live ? 0 : calls, halted, rubric: ['当前问题直接回答', '事实有当前来源支持', '连续指代正确', '建议有依据且具体适量', '拒绝后停止', '没有虚构记忆或后台行动'], records }, null, 2));
try {
  for (const scenario of cases) {
    const f = fixtureDb();
    f.items.clear();
    for (const material of evaluationMaterials) f.items.set(material.id, { _id: material.id, title: material.title, contentText: material.body, originalUrl: material.url, sourceId: 'source', scope: 'school', schoolIds: ['bjtu'], status: 'published', publishedAt: new Date().toISOString(), updatedAt: 'synthetic-v1' });
    f.rows('user_profiles').get(identity.dataOwnerId)!.aiAssistant = { bjtu: { preferences: { interests: ['编程'], goals: '积累项目经验' } } };
    const ai = aiService(f.db, f.repo, async (...args) => {
      if (calls >= 60) throw Object.assign(new Error('Evaluation call budget reached'), { code: 'PLATFORM_BUDGET_EXHAUSTED' });
      calls++;
      return live ? userCompletion(...args) : '〔仅验证流程，不能评价语言效果〕报名需提交报名表和一页项目简介。[R1](https://campus-eval.example.invalid/project)';
    });
    const chat = assistantChat(f.db, f.repo, ai, async () => ({ items: [], search: { state: 'idle', message: '' }, coverage: '合成资料' }));
    const conversation = await chat.handle('ai.chat.create', { schoolId: 'bjtu', requestId: `eval-conversation-${scenario.id}` }, identity) as AiConversation;
    const record: Record<string, unknown> = { id: scenario.id, name: scenario.name, review: scenario.review, humanScore: null, turns: [] };
    records.push(record);
    for (const [index, question] of scenario.questions.entries()) {
      let turn = await chat.handle('ai.chat.send', { conversationId: conversation.id, question, itemIds: ['notice', 'lecture'], requestId: `eval-${scenario.id}-${index}-request` }, identity) as AiChatTurn;
      while (turn.state === 'ready') turn = await chat.handle('ai.chat.step', { conversationId: conversation.id, turnId: turn.id, step: turn.step }, identity) as AiChatTurn;
      (record.turns as unknown[]).push({ question, state: turn.state, answer: turn.result, message: turn.message, references: turn.references });
      save();
      if (turn.state !== 'complete') { halted = true; break; }
    }
    if (halted) break; // No retry of failed or uncertain calls, including batches.
  }
} catch (error) {
  halted = true;
  records.push({ errorCode: typeof (error as any)?.code === 'string' ? (error as any).code : 'EVALUATION_FAILED', note: '评测已停止；未自动重发。' });
} finally {
  save();
  for (const key of configKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
}
console.log(JSON.stringify({ mode: live ? 'live' : 'dry-run', cases: records.length, providerCalls: live ? calls : 0, languageReview: 'pending', halted, output }));
if (halted) process.exitCode = 1;
