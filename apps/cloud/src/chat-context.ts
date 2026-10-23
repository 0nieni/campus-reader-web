/** Historical replies explain conversational references, not new facts. */
export interface HistoryEvidence { itemId: string; version: string }
export interface MemoryDependency { id: string; text: string }
export interface ContextExchange { question: string; answer: string; evidence: HistoryEvidence[]; memoryDependencies?: MemoryDependency[] }
export interface MemorySnapshot { enabled: boolean; generation: number; items: Array<{ id: string; slot: string; text: string; goalId?: string }> }
export interface ChatContext { history: string; expireAt: string; summary?: string; evidence?: HistoryEvidence[]; memory?: MemorySnapshot; memoryDependencies?: MemoryDependency[] }

export function buildChatContext(schoolId: string, preferences: { interests?: string[]; goals?: string } | undefined, exchanges: ContextExchange[], titles: string[], search?: { state: string; message: string }, summary?: { text: string; evidence: HistoryEvidence[]; memoryDependencies?: MemoryDependency[] }) {
  const shorten = (text: string, max: number) => text.length > max ? text.slice(0, max) + '…〔历史内容已缩短〕' : text;
  const recent = exchanges.slice(-3).map(entry => ({ ...entry, question: shorten(entry.question, 450), answer: shorten(entry.answer, 1200) }));
  const background = { schoolId, interests: (preferences?.interests || []).slice(0, 8).map(value => shorten(value, 50)), goals: shorten(String(preferences?.goals || ''), 600), activeTitles: titles.slice(0, 8).map(value => shorten(value, 80)), ...(search ? { search } : {}) };
  let backgroundTruncated = false;
  // Reserve space for dialogue. JSON escaping counts towards the actual budget.
  while (JSON.stringify(background).length > 1300) {
    backgroundTruncated = true;
    if (background.goals.length > 50) background.goals = shorten(background.goals, Math.floor(background.goals.length / 2));
    else if (background.activeTitles.length) background.activeTitles.pop();
    else if (background.interests.length) background.interests.pop();
    else break;
  }
  const serialize = () => JSON.stringify({ ...background, historyMayBeIncomplete: backgroundTruncated || recent.length < exchanges.length || recent.some(entry => entry.question.includes('〔历史内容已缩短〕') || entry.answer.includes('〔历史内容已缩短〕')), exchanges: recent.map(entry => ({ user: entry.question, assistant: entry.answer })) });
  while (serialize().length > 3500 && recent.length > 1) recent.shift();
  while (serialize().length > 3500 && recent[0]?.answer.length > 100) recent[0].answer = shorten(recent[0].answer, Math.floor(recent[0].answer.length / 2));
  const summaryText = summary?.text.trim() || '';
  const evidence = [...new Map([...recent.flatMap(entry => entry.evidence), ...(summaryText ? summary?.evidence || [] : [])].map(value => [JSON.stringify([value.itemId, value.version]), value])).values()];
  const memoryDependencies = [...new Map([...recent.flatMap(entry => entry.memoryDependencies || []), ...(summaryText ? summary?.memoryDependencies || [] : [])].map(value => [JSON.stringify([value.id, value.text]), value])).values()];
  return { history: serialize(), summary: summaryText, evidence, memoryDependencies };
}
