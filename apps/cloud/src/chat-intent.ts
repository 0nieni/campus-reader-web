/** Send only an explicit search subject, never saved memory or conversation history. */
export function chatSearchQuery(question: string): string | null {
  if (/^(?:请)?(?:不用|不要|别|无需|先不|不必|不想)/.test(question.trim()) || /(?:不用|不要|别|无需|先不|不必|不想)\s*(?:再)?\s*(?:联网|上网|搜索|搜|查找)|(?:只|仅)(?:看|用|读|查|搜)(?:已有|现有|已收录|本地)/.test(question)) return null;
  const command = /^(?:(?:请|麻烦|帮我|再|重新|也|替我|给我|能否|能不能|可以|帮忙|你|能|去|在网上)\s*)*(?:联网(?:搜索|查找|检索|搜|查|找)|上网(?:搜索|查找|检索|搜|查|找)|搜索|搜一下|搜一搜|搜搜|查找|检索|找找|找一下|找一找)/.exec(question.trim());
  if (!command) return null;
  const topics = ['编程', '创新创业', '创新', '科研', '项目', '竞赛', '比赛', '讲座', '学术', '论坛', '招聘', '实习', '就业', '奖学金', '助学金', '交流', '留学', '志愿', '社团', '活动', '招募', '申请', '报名', '通知', '公告'];
  const subject = question.trim().slice(command[0].length).split(/[，,。；;\n\r]/)[0]!.trim().replace(/[？?！!]+$/, '').slice(0, 200);
  // Personal clauses and credentials are not useful search terms. Preserve the
  // old topic-only fallback for those inputs rather than sending them outside.
  if (subject && !/@|https?:\/\/|\b(?:sk-|tvly-)|\b\d{11,}\b|密钥|密码|邮箱|手机号|身份证|我的|我是|我在/.test(subject)) return subject;
  return topics.filter(word => subject.includes(word)).join(' ') || '通知公告 报名';
}
