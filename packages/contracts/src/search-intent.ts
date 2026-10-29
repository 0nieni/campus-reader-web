// Only these public announcement topics may leave the app as a search query.
// Never return the question, saved interests, history, or private details.
const searchTopics = ['编程', '创新创业', '创新', '科研', '项目', '竞赛', '比赛', '讲座', '学术', '论坛', '招聘', '实习', '就业', '奖学金', '助学金', '交流', '留学', '志愿', '社团', '活动', '招募', '申请', '报名', '通知', '公告', '蓝桥杯', '挑战杯', '数学建模', '大创', '四六级', '英语四级', '英语六级', '计算机等级', '考研', '保研', '交换生'];

function isNonAction(question: string): boolean {
  return /["'“”‘’「」『』]|(?:如果|假如|假设|要是)|(?:同学|朋友|老师|别人|有人|他|她|他们|她们)(?:说|问|让我|想|希望|需要|要)|这(?:句|句话|个说法).*(?:意思|含义|解释)|(?:不用|不要|别|无需|不需要|先不|不必|不想)\s*(?:再)?\s*(?:联网|上网|搜索|搜|查找|找找)|(?:只|仅)(?:查看|使用|阅读|查询|检索|看|用|读|查|搜)(?:已有|现有|已收录|本地)/.test(question)
    || /^(?:请)?(?:不用|不要|别|无需|不需要|先不|不必|不想)/.test(question)
    || /^(?:(?:请|帮我|你能|能不能|可以)\s*)*(?:(?:解释|说明|介绍)(?:一下)?\s*)?(?:联网搜索|上网搜索|搜索(?:功能)?|检索(?:功能)?)(?:是(?:什么|什么意思)|怎么(?:实现|工作)|如何(?:实现|工作)|的(?:实现)?(?:原理|定义|含义))/.test(question);
}

function unwrapQuotedPublicTopics(question: string): string {
  return question.replace(/"([^\"]*)"|'([^']*)'|“([^“”]*)”|‘([^‘’]*)’|「([^「」]*)」|『([^『』]*)』/g, (quoted: string, ...groups: unknown[]) => {
    const topic = groups.slice(0, 6).find(value => typeof value === 'string');
    // Quoted instructions and arbitrary text retain their quotes and remain non-actions.
    return typeof topic === 'string' && searchTopics.includes(topic) ? topic : quoted;
  });
}

/** A question about this assistant's configured search capability, not a request to search. */
export function isSearchCapabilityQuestion(question: string): boolean {
  const text = question.trim().replace(/\s+/g, '');
  if (isNonAction(text)) return false;
  return /^(?:请问|想问一下|请告诉我)?(?:你|这里|这个助手|当前助手|系统)?(?:现在|目前|当前)?(?:是否)?(?:支持|可以|能不能|能否|能|可不可以)(?:联网|上网)(?:搜索|检索|查询)?(?:吗|么)?[?？。！!]*$/.test(text);
}

/** Explicit commands and campus announcement discovery; returns allowlisted topics only. */
export function chatSearchQuery(question: string): string | null {
  const text = unwrapQuotedPublicTopics(question.trim());
  if (!text || isNonAction(text) || isSearchCapabilityQuestion(text)) return null;
  const topics = searchTopics.filter(word => text.includes(word)).join(' ');
  const explicit = /^(?:(?:请|麻烦|帮我|再|重新|也|替我|给我|能否|能不能|可以|帮忙|你|能|去|在网上)\s*)*(?:联网(?:搜索|搜|查|找)|上网(?:搜索|搜|查|找)|搜索|搜一下|搜一搜|搜搜|查一下|查一查|查查|查找|检索|找找|找一下|找一找)/.test(text);
  if (explicit) return topics || '通知公告 报名';

  // Discovery needs a campus scope and a request for new/recent possibilities.
  // Questions about an existing notice's date, requirements, or materials stay local.
  const request = text.split(/[，,。！!；;\n]/, 1)[0];
  if (!topics || /(?:这个|这条|该|上述)(?:比赛|竞赛|活动|讲座|公告|通知)|(?:截止|材料|资格|要求|流程|地点|时间是什么|怎么报名)/.test(request)) return null;
  const campus = /^(?:(?:请|麻烦|帮我|替我|给我|你|能不能|能否|可以|能|看看|看下|了解一下)\s*)*(?:(?:最近|近期|这几天|这周|本周|这月|本月|现在|今天|目前)\s*)?(?:本校|我校|我们学校|我们校|咱们学校|咱们校|学校|校园)/.test(request);
  const current = /最近|近期|这几天|这周|本周|这月|本月|现在|今天|目前|新/.test(request);
  const possibilities = /有没有|有什么|有哪些|有.{0,20}[吗么]/.test(request);
  return campus && current && possibilities ? topics : null;
}
