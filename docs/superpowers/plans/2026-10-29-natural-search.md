# 自然提问触发搜索与能力说明 Implementation Plan

> For agentic workers: use subagent-driven-development and test-driven-development. 用户要求改善“人机感”，并明确指出联网好像不可用；先修复已复现的搜索链路，不把代码接入写成线上验收。

**Goal:** 自然表达能触发本校公告搜索，搜索能力/失败原因准确可见，不再把能力询问塞进公告报告。

**Architecture:** 共享纯函数识别校园发现意图与搜索能力询问；服务端从自身配置回答能力，真实搜索仍经Tavily适配、来源核验和正文授权。响应保留可选结构化错误分类，前端按真实状态提示。2026-11-01接续时按原对话已作决定保留main的全网公开搜索、个人服务商与显式选中资料合并；以下约束已相应校对。

**Tech Stack:** Existing Vue3/TypeScript, node:test/Vitest, no dependency or migration.

**Spec:** 本轮用户反馈及系统性排查证据；沿用docs/ai-reading-redesign.md与docs/ai-memory.md的学校、来源、额度和幂等约束。

## Global Constraints

- 保留main全网公开搜索与显式选中资料合并、搜索摘要非正文、20次/日及15秒间隔、重复请求不重搜、学校/账号失效隔离。自然校园发现绑定当前授权学校，普通问答不自动搜索。
- 自然校园发现只外发预设主题词加服务端学校名；明确全网命令保留最长200字符的本次公开主题，敏感语句退回主题词。不外发完整私人问题、历史、自动记忆、兴趣或联系方式；保留“不要联网/只看已有”等否定优先，引用、他人和假设不作为操作指令。
- “查一下”“帮我看看学校有没有新的讲座”“最近我们学校有什么比赛可以报名”应触发；“截止时间呢”“这个比赛的材料是什么”“你能联网吗”不实际搜索。能力询问只返回服务端配置事实，不等于检索已成功。
- 可选AiRecommendations.search.code为unconfigured/authorization/quota/rate_limited/timeout/network/provider/invalid_response/invalid_scope；不泄露Key、原始响应、异常或请求内容。仅结构化状态码可作诊断，不把任何连接失败归因于学校网络。
- ai.status新增可选searchConfigured:boolean，只说明密钥已配置，不验证有效性/余额/连通性。纯能力询问不需模型、不扣官方次数；普通提问额度不变。关闭/状态不明、记忆和来源机制均保留。
- 原基线69e4339含队友来源中心；不覆盖提醒、来源中心、选校、迁移或依赖。不改变生产环境配置，不主动发布；按原授权只推AI_module。
- 未取得真实Tavily/模型凭据与线上登录会话，不能宣称联网或语言质量实测成功。实际站点根页面本次读取失败，不据此断言站点故障。

## 用户进一步澄清后的交付约束

用户说明“能出来回答，但一看就没有联网”。因此本轮增加程序强制的结果分流：搜索unconfigured/failed时停止本轮模型调用并说明实际原因，保留下方已有公告入口；成功但未找到候选或没有可用于AI的正文时也直接说明，并提供已核验原文入口，不自动用旧资料生成看似联网的答案。成功且有可读正文才继续模型解释。

搜索结果增加可选candidateCount/readableCount，由服务端候选核验结果计算（合并本地卡片之前）；没有值的旧接口不伪造计数。AiChatTurn.programReply可选memory/search_capability/search_status，区别无需模型的回复；能力/搜索状态回复不触发无关的记忆与推荐重载。搜索状态与计数显示在答案前面。

## Task 1 共享自然意图（search_intent agent）

Files: new packages/contracts/src/search-intent.ts; apps/cloud/src/chat-intent.ts; new apps/cloud/tests/search-intent.test.ts.

- [x] TDD：三条已复现自然查询由null变为主题词；显式旧命令兼容；否定/引用/假设/他人/普通事实追问/能力询问不搜索；邮箱或个人秘密不出现在返回值。
- [x] Shared exports chatSearchQuery(question:string):string|null and isSearchCapabilityQuestion(question:string):boolean。原apps/cloud/src/chat-intent.ts只重导出，保持后端旧import兼容。root在contracts/index.ts导出两函数。
- [x] 能力询问支持“你能联网吗”“你可以联网搜索吗”“这里支持联网搜索吗”，与实际“能不能帮我查一下本校比赛”区分；问定义/实现/教程不冒充能力询问。
- [x] 独立测试与报告，不提交/改共享PROGRESS或其他文件。

## Task 2 搜索失败诊断（search_adapter agent）

Files: apps/cloud/src/announcement-search.ts and tests/announcement-search.test.ts only.

- [x] TDD：缺配置、401/403、429、432/433、5xx、超时、断网、JSON错误、学校域名错误、空成功分别可辨，候选过滤和大小/重定向限制继续生效。
- [x] SearchResult增加可选code（沿用Global Constraints类型）；HTTP状态诊断不得读取/回显原始错误；成功无code，空结果明确“未找到”且不冒充失败。保留8秒超时与有界读取。
- [x] 语气简短、说清现状及下一步；未配置提示联系网站管理员，密钥无效提示搜索服务授权异常，不能暗示用户输入模型Key可解锁搜索。
- [x] 测试与cloud类型检查报告，不改合同/共享PROGRESS或提交。

## Task 3 页面真实状态（search_ui agent）

Files: apps/web/src/components/AssistantPanel.vue; apps/web/tests/assistant.test.ts only.

- [x] TDD：能力询问在无模型/0官方次数/BYOK无Key时也能发送，实际搜索/普通问题不绕过模型额度；能力询问使用official程序路径、不附BYOK或选中文章。
- [x] import shared isSearchCapabilityQuestion via @campus/contracts（待Task1创建后可用）。兼容可选status.searchConfigured；sidebar按钮明确“联网找资料”，配置状态清楚且不把configured当作联网成功；缺配置时仍可查询状态，不声称可用。
- [x] 搜索状态/真实候选与正文计数前置；搜索成功但正文不可读有区别。programReply能力/搜索状态标明未调用模型，不做无关记忆/推荐刷新，含丢响应恢复；旧接口无标识行为兼容。保留账号/学校epoch及丢响应只读恢复，无假流式/推送/后台任务。
- [x] 组件测试、web类型检查、报告，不改合同/其他文件/共享PROGRESS、不提交。

## Task 4 后端接线与验收（root）

- [x] contracts定义可选search.code及status.searchConfigured，导出共享helpers。assistantService保留found.code并在无search请求时准确说明已配置/未配置。
- [x] TDD后在assistantChat准备锁取得后拦截能力询问，可信学校授权后保存程序回复，不查询来源/搜索/模型、不扣官方次数；结果区分configured与实际可用。请求重试仍幂等，取消/切校后迟到返回无效。
- [x] 集成测试三种自然查询确实调用discover一次且不外发隐私；权限/失效/失败/未配置依旧显示真实状态。ai.status测试只返回配置布尔值不泄露值。
- [x] 更新README/设计/PROGRESS与新docs/ai-search-troubleshooting.md，明确线上未验证、Tavily为独立服务端依赖、当前校园阅读流程导致生硬的已知边界；不声称本轮解决通用聊天或所有引用澄清问题。
- [x] npm ci/guide check/typecheck/test/build/netlify:build，独立非Astra任务与最终审查，neat-freak。最终只正常提交推AI_module、同步交付目录并记录真实证据。


## 接续验收结果（2026-11-01）

原计划四项已完成实现与非Astra审查，后续保留最新main e9bf410的全网公开搜索、个人服务商、资料库/MCP/匿名工作区及公告简讯；原学校域名限定以Global Constraints更新为准。用户新提供的个人规划提示词纳入实际指南v2.7，原文仅调整标题层级。

最终指南/typecheck、全量906项（web300/cloud606）、普通build、Netlify完整构建通过，产物含16函数；实际最终请求收到用户提示词，八场景dry-run零供应商调用。SQL定向15项及整体222项专项通过。文档/生成指令同步，独立复核闭合；真实模型、Tavily及生产账号/语言效果pending。分支推送和交付目录结果以PROGRESS最终记录为准，不合main、不主动部署、不清场。
