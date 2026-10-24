# AI Provider Profiles Implementation Plan

**Goal:** 按已确认设计，将个人服务商和模型保存、选择、切换接入现有 AI 阅读。
**Architecture:** 专用账号配置表保存加密密钥，独立服务维护版本和当前项。现有聊天与任务携带无密钥的配置引用，执行适配器按协议调用受约束的 HTTPS 接口。
**Tech Stack:** Vue 3、TypeScript、Node crypto/https、Netlify Identity/Functions、PostgreSQL。
**Spec:** `docs/superpowers/specs/2026-10-24-ai-provider-profiles-design.md`（用户已确认）。
**Execution:** 同一会话实施，独立子任务并行开发，集成后独立审查；不推送或发布。

## Global Constraints

- 独立检出以 main `b6e383f` 为基线，不带入 root 管理后台或 retained-materials 分支的改动。
- 每账号最多10项，每项最多20个模型；密钥只以 AES-256-GCM 密文落盘，主密钥仅服务端环境变量。
- 保留官方日账户、旧临时 BYOK、资料授权、未知请求暂停、24小时期限。
- 未完成任务固定配置版本；切换不调用模型、不改变已创建轮次；编辑/删除使后续批次停止。
- 不运行上游 CC Switch、不读取其用户配置、不调用真实模型。

## Review Focus

- 同 requestId 与切换/编辑/慢检索竞态，检查仍用初始配置快照。
- 第一次新增和并发到达第10项边界，通过账号状态行锁串行执行。
- 留空保留密钥时重新绑定版本加密，错误主密钥和串换密文均失败。
- 删改与模型请求/结果提交竞态不发布失效结果；已完成结果不被误删。
- 自定义域名、重定向、错误流、Gemini模型路径及响应结束状态都不绕过网络和格式限制。

## Task 1: Contracts and encrypted storage

Files: `packages/contracts/src/ai-providers.ts`, `apps/cloud/src/ai-provider-profiles.ts`, `netlify/database/migrations/20261024000300_ai_provider_profiles.sql`, focused store tests.

- [x] 定义 AiProviderRef `{id,version}`、公开元数据、账号状态、CRUD/select 动作。
- [x] 以 `providerProfiles(pool,{encryptionKey,now})` 提供 `state(owner)`, `handle(action,input,owner)`, `resolve(owner,ref,model)`, `guard(tx,owner,ref,model)`。
- [x] 编写失败测试：密文无明文、owner隔离、版本冲突、限额、改变地址重新输入Key、留空Key重加密。
- [x] 实现专用表与账号状态锁；新增独立迁移，不改已应用迁移。
- [x] 运行配置存储测试，确认真实本地SQL和加密行为。

## Task 2: Provider protocols and task binding

Files: `provider-endpoints.ts`, `model-provider.ts`, `ai-service.ts`, `assistant-chat.ts`, `assistant-service.ts`, `gateway.ts`, `netlify/functions/api.mts`, protocol/chat/task tests.

- [x] 统一 HTTPS 基础地址和四种协议 endpoint 规则，保留旧官方端点约束。
- [x] 编写并实现 Chat/Responses/Anthropic/Gemini 请求、响应和失败测试，不连接真实上游。
- [x] 网关登记配置动作和 providerProfile；可信身份解析加密密钥；入口显式注入主密钥。
- [x] 在聊天占位和任务中固定引用；批次领取与结果提交受版本锁约束。
- [x] 编辑/删除后未完成任务明确失败并释放占位；旧完成结果仍可读；官方额度不变。
- [x] 运行相关协议、聊天、幂等和额度回归。

## Task 3: Saved provider interface

Files: `apps/web/src/components/AiProviderSettings.vue`, `AssistantPanel.vue`, focused Vue tests.

- [x] 服务商列表、预设/自定义表单、模型列表、密码框、编辑/删除、明确设为当前。
- [x] 输入Key保存后清空，不写Storage；加载只接收无密钥元数据。
- [x] 保存与选择分开；新轮次发 providerProfile；恢复已有轮次不索取已保存的Key。
- [x] 保留临时BYOK和官方入口，切账号/离页清空未保存草稿及旧响应。
- [x] 验证保存/更新/删除/切换/刷新恢复、在途任务不混用及移动端布局。

## Task 4: Integration and review

- [x] `npm ci`、`npm run typecheck`、`npm test`、`npm run build`、`npm run netlify:build`。
- [x] 合成账号/公告/配置的本地浏览器预览，不连接生产数据或真实模型。
- [x] 独立审查密钥泄露、跨账号和并发失效路径，并修复必要问题。
- [x] 更新 README、PROGRESS、配置指南和固定提交源码分析记录。
- [x] 最终报告区分源码观察、本站设计、本地测试、真实模型与上线待办；不发布生产。
