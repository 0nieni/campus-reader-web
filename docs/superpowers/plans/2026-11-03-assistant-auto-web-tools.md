# AI 搭子自动联网 Implementation Plan

> For agentic workers: use superpowers:executing-plans in this session. User approved the design and native execution on 2026-11-03; do not reopen the same approval gate.

**Goal:** 默认让聊天模型自主搜索并选读公开网页，最终回答带真实来源。

**Architecture:** 在现有 AI 逐步任务内增加协议无关的工具状态，一步最多一次模型或一次工具请求。搜索与读取复用现有 DeepSeek、URL 策略和临时正文存储；模型协议层负责工具消息编码和严格解析，旧任务保持文本接口。

**Tech Stack:** Vue 3 / TypeScript / Node.js >=22.12 / Netlify Functions / existing JSON task storage; no new dependencies or migrations.

**Spec:** ../specs/2026-11-03-assistant-auto-web-tools-design.md (approved default automatic mode).

## Global Constraints

- 每账号 Search 每天20次、至少间隔15秒；每轮最多2次Search、3次Fetch、4次工具阶段模型请求、8篇资料、每次5候选。
- 官方同一成功轮次结算一次；每次实际模型请求分别计入平台预算。未知状态不重放。
- 服务端统一DeepSeek Key；禁止向搜索外发历史、记忆、私密正文或凭据。
- 工具新增正文纳入账号/学校/版本/许可/24小时到期校验，只有读到的正文可引用。
- 原部署、提醒、选校、旧任务和临时API/个人配置保持兼容；不自行更换模型。

## Review Focus

1. 四种协议的工具回填不是普通文本，错误结束状态不得采纳（Task1）。
2. 不选公告仍能发起工具决策；否定联网不可绕过（Task3）。
3. 模型注入的任意URL、私密搜索词与未知参数不能实际外发（Task2/3）。
4. 重复step、请求取消、读取后撤权不能重复计费或发布旧资料（Task3）。
5. 达到预算或模型不支持tools时必须有可见原因、保留手动搜索（Task3/4）。

### Task1: 模型工具协议

Files: new apps/cloud/src/model-tools.ts, apps/cloud/tests/model-tools.test.ts; modify model-provider.ts.
Interfaces: ToolCall {id,name,arguments}; ToolExchange {calls,results}; ToolCompletion {text,calls}; toolPayload(protocol,...), toolResponse(protocol,...), userToolCompletion(connection,guide,content,maxTokens,endpoint,options).

- [ ] 先编写并运行失败测试：四种协议请求/响应与回填配对；过滤、截断、重复id、未知工具、恶意参数、禁用工具后仍返回调用均拒绝。
- [ ] 实现协议无关消息和严格解析，复用现有HTTPS、DNS锁定、大小和超时保护。旧userCompletion仍拒绝意外工具调用。
- [ ] 运行协议与旧model-provider回归，提交本任务。

### Task2: 安全的按需搜索/读取

Files: new apps/cloud/src/chat-web-tools.ts + tests; modify assistant-service.ts.
Interfaces: ChatWebTools.search(schoolId,query,identity) -> AiRecommendations; read(schoolId,candidate,identity) -> AiRecommendations. 工具搜索不自动读取；工具读仅接受本轮已返回候选，沿用recommendations入库/来源检查，手动搜索仍读前三条。

- [ ] 先编写并运行失败测试：search无Fetch、选读一个才读一个、恶意query不外发、旧URL禁用不导入、日限额同用。
- [ ] 从recommendations提取内部受信任模式，保留实际候选计数和许可；封装公开主题校验及否定联网判定。
- [ ] 运行chat-web-tools、chat-discovery和assistant-service回归，提交本任务。

### Task3: 幂等的逐步工具循环

Files: new apps/cloud/src/chat-agent.ts + tests; modify ai-service.ts, assistant-chat.ts, chat-context.ts, assistant-cleanup.ts, contracts assistant.ts.
Interfaces: task.chat.webTools controls internal mode; task.agent records bounded exchanges/pending calls/candidates/counts/search metadata. ai.setChatWebTools(runtime) connects service without public gateway permissions. One ai.step performs one external action and advances task.step exactly once.

- [ ] 先编写并运行失败测试：无预选资料search→read→带引用答复、模型直接答复不搜索、禁用联网、错误/空结果、未知候选、次数上限、重复step/并发取消/撤权/过期、官方只计一次且每次模型扣平台预算。
- [ ] 允许仅内部webTools聊天的空资料包，保留旧readingPackage的1～8篇限制；final可跨工具步骤，公共输出读取最新任务引用和搜索状态。
- [ ] 工具消息随任务chat清理；限制上下文与调用次数，异常沿用不明状态/取消/核查，不自动重试模型。
- [ ] 运行工具任务和既有额度/多轮/个人配置/SQL回归，提交本任务。

### Task4: 页面、指令与最终验收

Files: AssistantPanel.vue + web tests; docs/ai-reading-guide.md, README.md, docs/ai-reading-redesign.md, PROGRESS.md.

- [ ] 先编写并运行页面失败测试：自动搜索轮次真实状态与来源可见，失败仍可用手动搜索，普通问题不伪装已搜索。
- [ ] 更新实际模型指令，生成chat-guide.ts；状态展示接线，无新产品必填流程。
- [ ] npm ci --ignore-scripts; npm run typecheck; npm test; npm run build; npm run netlify:build; git diff --check。
- [ ] 按executing-plans要求对全分支进行fresh-context review，修复重要问题并验证；本地预览QA和真实调用/发布分层记录，不把本地通过写成上线成功。

Self-review: task interfaces and limits match spec; same runtime injected into aiService and assistantService; tests exercise behavior rather than source text. Native execution already selected by user.
