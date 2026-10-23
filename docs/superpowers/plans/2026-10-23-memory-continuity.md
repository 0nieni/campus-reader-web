# 连续对话与多目标记忆 Implementation Plan

> For agentic workers: use subagent-driven-development and test-driven-development. 用户已批准先做建议1/2/3，继续执行，不重复请求授权。

**Goal:** 承接较早对话，支持聊天内纠正/删除记忆，并同时保留少量独立目标。

**Architecture:** 在既有对话中生成有来源依赖的摘录摘要；用户档案JSON兼容扩展为多目标。明确记忆命令由服务端规则处理，无需公告、模型或官方额度；不明确时只澄清。同一次成功模型回复仍提取自动记忆。

**Tech Stack:** Vue3/TypeScript，既有SQL/CloudBase存储，node:test/Vitest，无新依赖和迁移。

**Spec:** 用户确认的上轮建议1/2/3；本文件明确首版实现边界，沿用 docs/ai-memory.md 和 docs/ai-reading-redesign.md 的授权、来源、计次约束。

## Global Constraints

- 沿用3轮官方日账户、状态不明暂停、24小时会话固定到期；不增加模型调用、后台任务、推送或选校引导。
- 摘要为程序从已完成、仍有权限的较早问答提取的有界摘录，不宣称模型理解的完整总结；原文事实不能因此免于核验。近期3轮仍约3500字符；额外摘要最多1200字符，整体模型输入仍22000字符。
- 摘要不得带入失效/删除/过期记忆、取消/失败/未完成回答、撤权/改版来源或其他账号学校信息；资料依赖随每批发送和接受结果继续校验；清除/到期随原任务一起清理。
- 4个单值槽major/year/interests/response_style；最多3个goal，每目标最多1个progress，兼容旧id=goal/progress。新目标稳定id；progress带goalId，多个目标时不自动猜归属。每条180字符、每轮最多2候选；逐字证据和敏感信息校验保留。
- 目标180天，进展30天且不超过目标期限；年级365天，其他稳定槽至替换或删除。只将当前问题相关目标/进展带入模型，泛问可带最多3目标；推荐仍使用有效目标并说明来源，不推断资格。
- 明确记忆指令无需确认弹窗。支持“忘掉我的专业”“清空自动记忆”“我现在不准备考研了”“把目标…改成…”及明确专业纠正。歧义不删除；否定/假设/他人/引用指令不执行。仅自动记忆，不删除手填偏好。
- 删除/明确纠正提高generation，旧任务/摘要和迟到回调失效；请求编号幂等。关闭时仍可删除，但不能借纠正重新学习；未匹配命令不声称完成操作。
- 不触碰队友提醒、选校或迁移；不写Codex个人记忆；按既有授权只推AI_module，不合main或主动部署。

## Task 1 存储与自然语言命令

Owner: memory_goals agent. Files: packages/contracts/src/assistant.ts; apps/cloud/src/assistant-memory.ts; new memory-command.ts; corresponding tests; assistant-cleanup.ts/tests only if needed.

- [x] 先失败测试：旧六槽兼容；三个独立目标不覆盖、第四个不静默挤出；进展归属明确、删除目标级联；到期及迟到回调；明确忘记/纠正/歧义/假设/敏感内容/禁用/并发/幂等。
- [x] AiMemoryItem.id改string，增加可选goalId:string；forget输入id:string，slot仍六种。MemoryProposal增加可选goalId用于既有目标更新或进展关联，旧goal无goalId生成新稳定id且保留旧数据可读。
- [x] memoryService新增command(owner,schoolId,{requestId,question}):Promise<{handled:boolean,message?:string,changed?:boolean}>。仅可信当前学校、内部调用；匹配和变更同事务，命令请求去重；不确定先返回具体澄清，request重放不再修改generation。
- [x] 新增selection helper供主控选相关目标，固定背景始终可带，最多3目标及其进展，总最多10条；问题无目标命中泛问带全部目标，明确命中只带对应。旧孤立progress保守兼容。
- [x] 运行专项与真实SQL回归、cloud typecheck，报告证据和边界。不得提交、改共享PROGRESS或额外文件。

## Task 2 摘录摘要

Owner: continuity_summary agent. Files: apps/cloud/src/chat-context.ts; new conversation-summary.ts; corresponding tests.

- [x] 先失败测试：第4轮之后更早决定仍入摘要、近期不重复、有界、来源证据保留、不接受空/未完成内容、用户纠正优先。
- [x] export buildConversationSummary(exchanges:ContextExchange[]):{text:string,evidence:HistoryEvidence[]}。调用方仅传通过完整权限/记忆核验的旧问答；最多1200字符含标记，抽取逐字问题/答案，不生成新事实。优先含决定/目标/未解决事项，较新纠正优先，截断显式标注；依赖只取实际进入摘要的问答。
- [x] buildChatContext增加第6可选参数summary，summary文本放单独ChatContext.summary字段或同返回字段；history仍3500预算，evidence合并去重摘要依赖。主控接线发送及接收校验，不改assistant-chat/ai-service。
- [x] 单测通过报告，不提交、不改合同或共享PROGRESS。

## Task 3 页面兼容

Owner: memory_goals_ui agent. Files: apps/web/src/components/AssistantPanel.vue; apps/web/tests/assistant.test.ts; optional small pure command hint helper in web.

- [x] 先失败组件测试：多个目标独立列表及进展归属；按实际string id删除；纯记忆命令在未配置模型/额度耗尽时仍可发，普通问题仍禁用；服务端不明确命令反馈显示。
- [x] 不新增确认；为目标显示易读关联和期限；命令完成刷新memory/recommendations，保留epoch/账号学校隔离和原有BYOK/额度规则。
- [x] UI仅保守识别明显记忆命令以开放发送，后端才执行或澄清；不在浏览器改记忆。例：忘掉我的专业、清空自动记忆、我现在不准备考研了、把目标考研改成准备实习。
- [x] 运行组件测试和web typecheck，报告，不提交或改其他文件。

## Task 4 集成与指南（主控）

- [x] 先失败集成用例：记忆命令不调用推荐/搜索/模型/配额；重复请求不反复删除；第4+轮摘要包含旧决定、撤权停止发送；选择相关目标；多目标自动保存可再读取。
- [x] assistant-chat在准备锁取得后先command，handled直接保存程序reply结束；其余流程正常。摘要从row.turns.slice(0,-3)的有效轮次构造，权限失效不携入；ChatContext.summary跟随同一任务。
- [x] ai-service发送摘要为非事实/指令背景，摘要证据并入原有逐批授权；memory snapshot按helper选相关目标/进展。旧任务仍兼容。
- [x] 指南v2.4加入目标id/goalId、命令诚实反馈、摘要不替代证据；运行生成与guide check。同步README、设计、ai-memory、PROGRESS，修正6槽上限旧说法。
- [x] npm ci/typecheck/test/build/netlify:build，独立非Astra审查，neat-freak；真实模型未调用如实标记。
- [x] 普通提交推送AI_module，核对远端SHA并同步交付根目录。
