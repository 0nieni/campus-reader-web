import type { ContextExchange, HistoryEvidence, MemoryDependency } from './chat-context';

const SUMMARY_LIMIT = 1200;
const HEADER = '较早问答摘录（优先保留较新纠正，仅供理解上下文，不作事实依据）';
const SHORTENED = '〔摘录已缩短〕';
const OMITTED = '\n〔部分较早问答未收录〕';

function priority(text: string): number {
  if (/更正|纠正|改为|改成|不再|不准备|取消.*(?:目标|计划)|其实/.test(text)) return 2;
  if (/决定|目标|计划|准备|待办|尚未|还没|未完成|未解决/.test(text)) return 1;
  return 0;
}

function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  let start = 0;
  let focusPriority = 0;
  for (const sentence of text.matchAll(/[^。！？!?\n]+[。！？!?]?/gu)) {
    const score = priority(sentence[0]);
    if (score && score >= focusPriority) {
      focusPriority = score;
      start = sentence.index || 0;
    }
  }
  const prefix = start ? SHORTENED : '';
  const fragment = text.slice(start);
  const available = max - prefix.length;
  return prefix + (fragment.length > available ? fragment.slice(0, available - SHORTENED.length) + SHORTENED : fragment);
}

/** Caller supplies only completed older exchanges with current source and memory permission. */
export function buildConversationSummary(exchanges: ContextExchange[]): { text: string; evidence: HistoryEvidence[]; memoryDependencies: MemoryDependency[] } {
  const candidates = exchanges.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.question.trim() && entry.answer.trim())
    .sort((a, b) => Math.max(priority(b.entry.question), priority(b.entry.answer)) - Math.max(priority(a.entry.question), priority(a.entry.answer)) || b.index - a.index);
  if (!candidates.length) return { text: '', evidence: [], memoryDependencies: [] };

  let text = HEADER;
  const included: ContextExchange[] = [];
  for (const { entry } of candidates) {
    const fragment = `\n问：${excerpt(entry.question.trim(), 200)}\n答：${excerpt(entry.answer.trim(), 340)}`;
    // Keep complete question/answer pairs and reserve the explicit omission marker.
    if (text.length + fragment.length + OMITTED.length > SUMMARY_LIMIT) continue;
    text += fragment;
    included.push(entry);
  }
  if (included.length < candidates.length) text += OMITTED;
  const evidence = [...new Map(included.flatMap(entry => entry.evidence).map(value => [JSON.stringify([value.itemId, value.version]), value])).values()];
  const memoryDependencies = [...new Map(included.flatMap(entry => entry.memoryDependencies || []).map(value => [JSON.stringify([value.id, value.text]), value])).values()];
  return { text, evidence, memoryDependencies };
}
