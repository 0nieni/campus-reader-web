import type { AiMemorySlot } from '@campus/contracts';

/** Conversations expire at 24h; retain complete command replay results for twice that window. */
export const memoryCommandReceiptLifetimeMs = 48 * 3600000;

export type MemoryCommand = { kind: 'clear' } | { kind: 'forget'; slot: AiMemorySlot } | { kind: 'forgetGoal'; target: string }
  | { kind: 'correct'; slot: 'major'; text: string } | { kind: 'replaceGoal'; target: string; text: string } | { kind: 'clarify' };
const uncertainCorrection = /或|还是|的话|要是|什么|哪些|怎么|如何|怎样|为何|为什么|有何|有没有|是否|能否|能不能|会不会|好不好|帮我|告诉我|(?:能|可以|想|要)(?:选|报|参加|做|去|学)|\b(?:or|whether)\b/i;

/** Only whole, direct personal directives are commands; quoted or conditional text stays conversation. */
export function parseMemoryCommand(question: string): MemoryCommand | null {
  if (typeof question !== 'string' || question.length > 10000 || /[\u0000-\u001f\u007f“”「」『』"'`]/.test(question)
    || /如果|假如|假设|假装|例如|举例|示例|朋友|同学|室友|别人|他人|公告|原文|不要|不许|别把|别忘|不能|不想|不希望|是否|[?？]|[吗呢吧][。！!\s]*$|\b(?:if|suppose|imagine)\b/i.test(question)) return null;
  const value = question.trim().replace(/[。！!]+$/, '').replace(/^(?:请|麻烦)(?:你)?/, '').trim();
  if (/[，,。；;]/.test(value)) return null;
  if (/^(?:清空|清除|删除)(?:我的)?(?:全部|所有)?自动记忆$/.test(value)) return { kind: 'clear' };
  const slot = value.match(/^(?:忘掉|忘记|删除|清除)(?:我的|我)(专业|年级|兴趣|回答偏好|回复偏好|回答风格|回复风格|目标|进展)$/);
  const namedSlots: Record<string, AiMemorySlot> = { 专业: 'major', 年级: 'year', 兴趣: 'interests', 回答偏好: 'response_style', 回复偏好: 'response_style', 回答风格: 'response_style', 回复风格: 'response_style', 目标: 'goal', 进展: 'progress' };
  if (slot) return { kind: 'forget', slot: namedSlots[slot[1]]! };
  const forget = value.match(/^(?:忘掉|忘记|删除|清除)(?:我的)?目标\s*(.+)$/);
  if (forget) return { kind: 'forgetGoal', target: forget[1].trim() };
  const abandon = value.match(/^我(?:现在|目前)?(?:不再准备|不准备|不再计划|不打算)(.+?)(?:了)?$/);
  if (abandon) return { kind: 'forgetGoal', target: abandon[1].trim() };
  const replace = value.match(/^把(?:我的)?目标\s*(.+?)\s*改(?:成|为)\s*(.+)$/);
  if (replace) return uncertainCorrection.test(value) ? { kind: 'clarify' } : { kind: 'replaceGoal', target: replace[1].trim(), text: replace[2].trim() };
  const major = value.match(/^(?:我的专业(?:现在)?(?:是|改成|改为)|纠正(?:一下)?我的专业(?:为|是))([\p{L}\p{N} +.·_-]{1,60})$/u)
    || value.match(/^我(?:现在(?:是|主修)|已经转到)([\p{L}\p{N} +.·_-]{1,60}专业)$/u);
  if (major && !uncertainCorrection.test(value)
    && (!major[1].includes('专业') || major[1].endsWith('专业') && major[1].indexOf('专业') === major[1].length - 2)) return { kind: 'correct', slot: 'major', text: value };
  if (/^(?:我的专业(?:现在)?(?:改成|改为)|纠正(?:一下)?我的专业)/.test(value)) return { kind: 'clarify' };
  if (/^(?:忘掉|忘记|删除|清除)(?:那个|这个|该)(?:目标|记忆)$|^把(?:我的)?目标.*改/.test(value)) return { kind: 'clarify' };
  if (/^(?:忘掉|忘记|删除|清除)(?:我的|我).*(?:专业|年级|兴趣|偏好|目标|进展|记忆)/.test(value)) return { kind: 'clarify' };
  return null;
}

const stopWords = /我(?:的|现在|目前|希望|想|要)?|本人|准备|计划|打算|目标|长期|参加|报名|申请|报考|希望|想要|提升|积累|完成|获得|正在|已经|学习|未来|\b(?:i|my|want|plan|prepare|apply|learn|study|to|for|am|the)\b/gi;
export function goalTerms(text: string): string[] {
  const terms = text.toLowerCase().replace(stopWords, ' ').match(/[a-z0-9][a-z0-9_+-]{1,}|[\u4e00-\u9fff]{2,}/g) || [];
  return terms.flatMap(term => /^[\u4e00-\u9fff]+$/.test(term) ? Array.from({ length: term.length - 1 }, (_, i) => term.slice(i, i + 2)) : [term]);
}
export function goalMatches(text: string, target: string): boolean {
  const terms = goalTerms(target), goal = text.toLowerCase();
  return terms.length > 0 && terms.every(term => goal.includes(term));
}
