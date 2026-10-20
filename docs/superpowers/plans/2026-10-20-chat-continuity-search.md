# 连续对话与聊天搜索 Implementation Plan

> **For agentic workers:** Execute with executing-plans, following each test-first checkpoint below. User approved these changes in chat; no additional design approval is needed.

**Goal:** 让校园助手能承接近期回答，并对明确搜索请求检索本校公告。

**Architecture:** 对话服务保存有限的近期问答及来源版本依赖；原任务执行器在每批发送和接收时重新校验依赖。搜索复用已有适配、限流和来源核验，准备阶段先取得会话锁，同一请求不重复搜索。搜索状态随轮次返回并直接显示。

**Tech Stack:** TypeScript, Vue 3, node:test, existing Database/Repository abstractions.

**Spec:** 用户在本对话确认的改进建议第 1、2 项，以及真实模型评测准备；已有边界见 docs/ai-reading-redesign.md。

## Global Constraints

- 与高级任务共用每天最多三轮的官方账户；状态不明不重发。
- 账号、学校、来源许可、资料版本及固定 24 小时到期均重新校验。
- 不保存密钥，不新增迁移、后台任务、选校引导或推送。
- 搜索仅由明确请求触发；否定搜索请求不触发，不把历史全文或用户档案发送搜索服务。
- 真实模型未配置时只提供可运行评测，不把桩测试标为语言评测。

## Task 1: 有限问答上下文

Files: apps/cloud/src/assistant-chat.ts, apps/cloud/src/chat-context.ts, apps/cloud/src/ai-service.ts, apps/cloud/tests/assistant-chat.test.ts.

- [x] 新增集成测试，完成一轮后追问“第二个建议”，断言真实任务的最终调用含前一回答；新增历史资料撤权/变更后不发送、不接受的测试。
- [x] 运行 `node_modules/.bin/tsx --test apps/cloud/tests/assistant-chat.test.ts`，确认新增测试因历史缺失而失败。
- [x] 提取上下文构造器：最近三轮，明确 user/assistant 角色，单项截断标记，完整 JSON 不硬截断；保留偏好与来源版本依赖。
- [x] 在 ai-service 的任务读取中验证历史来源依赖，依赖正文只核验，不作为本轮事实资料。
- [x] 运行相同测试及 chat-style 测试，确认通过。

## Task 2: 聊天触发检索

Files: apps/cloud/src/chat-intent.ts, apps/cloud/src/assistant-chat.ts, apps/cloud/src/assistant-service.ts, packages/contracts/src/assistant.ts, apps/web/src/components/AssistantPanel.vue; corresponding cloud/web tests.

- [x] 新增服务集成测试：明确搜索、否定搜索、成功正文、未配置/失败降级、同编号并发、不同编号会话锁、切校/取消后丢弃返回。
- [x] 运行新增测试，确认缺少对话内检索行为而失败。
- [x] 服务端识别明确搜索意图，按主题生成有界查询，复用 recommendations；准备先锁定轮次，保存搜索结果和状态，失败/取消/超时允许安全退出且不重搜。
- [x] 历史和本轮检索状态进入任务，前端独立显示状态；选中资料只在非搜索轮次限定范围。
- [x] 运行 cloud 与组件测试，覆盖现有预占、幂等和撤权规则。

## Task 3: 评测与知识同步

Files: tools/evaluate-ai-chat.ts, apps/cloud/evals/, docs/ai-reading-guide.md, generated chat-guide.ts, README.md, docs/ai-reading-redesign.md, PROGRESS.md.

- [x] 提供八类合成情境、人工评分标准和默认 dry-run；live 模式只读取服务端环境变量，状态不明立即停止，不自动重试，不输出密钥。
- [x] 执行 dry-run，缺配置时 live 模式明确拒绝，记录真实模型评测未运行。
- [x] 同步指南并执行 `node tools/sync-ai-guide.mjs` 与 `npm run ai:guide:check`。
- [x] 执行 npm ci、typecheck、全量测试、build、netlify:build；完成独立审查和 neat-freak 收尾判定。
- [ ] 在已核实的 AI_module 独立检出比较并集成本轮文件，普通提交推送；核对远端，不强推、不部署。
