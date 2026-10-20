/** Synthetic evaluation data only. Never import into the site's database. */
export const chatCases = [
  { id: 'recommendation', name: '推荐', questions: ['我关注编程，想积累项目经验，这两条公告哪条值得关注？'], review: '先比较相关性，理由有依据，不把兴趣说成符合资格。' },
  { id: 'continuity', name: '连续指代', questions: ['我想参加项目竞赛，给我两条准备建议。', '你刚才说的第二个建议具体怎么做？'], review: '第二轮应正确承接自己提出的第二项建议，不重新猜活动。' },
  { id: 'brief', name: '简单追问', questions: ['项目竞赛需要哪些材料？', '只说截止时间，简短点。'], review: '只回答时间并引用，不重复背景或额外规划。' },
  { id: 'missing', name: '资料不足', questions: ['学术讲座需要交多少钱？'], review: '正文未说明费用，不推断免费，不强加后续规划。' },
  { id: 'ambiguity', name: '歧义澄清', questions: ['这两个活动我都感兴趣。', '这个要交什么材料？'], review: '指代不明时澄清，不擅自挑选其中一个。' },
  { id: 'correction', name: '用户纠正', questions: ['讲讲竞赛报名。', '我刚才说错了，我问的是讲座，只说地点。'], review: '及时切换对象，只回答讲座地点，不继续沿用竞赛信息。' },
  { id: 'milestone', name: '阶段完成', questions: ['项目竞赛需要什么材料？', '报名表和项目简介已经交了，接下来呢？'], review: '承接已完成事项，可建议核对答辩要求；不能宣布审核通过。' },
  { id: 'refusal', name: '拒绝建议', questions: ['我想积累项目经验，报名要什么？', '先别给建议，只说材料。', '讲座地点呢？'], review: '拒绝后连续两轮停止延伸建议，仍正常回答当前问题。' },
] as const;

export const evaluationMaterials = [
  { id: 'notice', title: '示例大学项目竞赛报名通知', url: 'https://campus-eval.example.invalid/project', body: '合成评测资料。项目竞赛面向在校本科生，报名需提交报名表和一页项目简介，截止时间为 2026 年 11 月 25 日 17:00。报名后需参加答辩，答辩具体时间另行通知。资料未确认任何用户是否通过审核。' },
  { id: 'lecture', title: '示例大学学术讲座通知', url: 'https://campus-eval.example.invalid/lecture', body: '合成评测资料。学术讲座面向全校学生，地点为图书馆报告厅，现场携带学生证。正文未说明费用、活动时间或其他材料，不得补充推断。' },
] as const;
