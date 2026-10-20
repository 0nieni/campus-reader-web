/** Conservative explicit commands only. Never forward the whole conversation,
 * saved goals, or an arbitrary user sentence to an external search service. */
export function chatSearchQuery(question: string): string | null {
  if (/^(?:请)?(?:不用|不要|别|无需|先不|不必|不想)/.test(question.trim()) || /(?:不用|不要|别|无需|先不|不必|不想)\s*(?:再)?\s*(?:联网|上网|搜索|搜|查找)|(?:只|仅)(?:看|用|读|查|搜)(?:已有|现有|已收录|本地)/.test(question)) return null;
  const command = /^(?:(?:请|麻烦|帮我|再|重新|也|替我|给我|能否|能不能|可以|帮忙|你|能|去|在网上)\s*)*(?:联网(?:搜索|搜|查|找)|上网(?:搜索|搜|查|找)|搜索|搜一下|搜一搜|搜搜|查找|检索|找找|找一下|找一找)/.exec(question.trim());
  if (!command) return null;
  const topics = ['编程', '创新创业', '创新', '科研', '项目', '竞赛', '比赛', '讲座', '学术', '论坛', '招聘', '实习', '就业', '奖学金', '助学金', '交流', '留学', '志愿', '社团', '活动', '招募', '申请', '报名', '通知', '公告'];
  return topics.filter(word => question.includes(word)).join(' ') || '通知公告 报名';
}
