# 自动用户记忆 Implementation Plan

> **For agentic workers:** Use subagent-driven-development and test-driven-development. 用户已明确要求 AI 自行识别重要且必要的信息并保存，不再逐条确认；此计划直接执行该决定。

**Goal:** 在成功对话中自动识别有用的用户事实，跨会话使用，允许管理但不要求逐条确认。

**Architecture:** 使用既有 user_profiles JSON 的 aiMemory[schoolId]，不新增集合或迁移。模型在同一次最终回复末尾输出隐藏结构化候选，程序去除元数据、验证引用后，按真实身份及学校保存。generation 用于删除/开关后的任务失效，version 用于管理界面冲突检测；自动写入不改变 generation。

**Tech Stack:** Vue 3 / TypeScript / existing Database, node:test and Vitest.

**Spec:** 本文件的全局约束及本对话用户的自动保存要求；沿用 docs/ai-reading-redesign.md 的账号、来源、额度规则。

## Global Constraints

- 默认 enabled=true，不逐条确认；行为学习开关仍默认关闭，互不替代。
- 固定六槽 major/year/interests/response_style/goal/progress，每槽最新一条，每条最多180字符；候选每轮最多2条，只接受当前用户问题中的逐字证据，text===evidence，不接受公告、历史助手或假设/他人信息。
- major/interests/response_style 无固定到期；year 365天，goal 180天，progress 30天。过期条目读时立即排除；不无限保存原始聊天、证据全文或附件。
- 保存成功问答之后执行，失败/未知/取消不写；隐藏JSON绝不显示在回复、导出和后续历史中。不新增模型调用或官方日额度。
- 记忆不作为公告事实来源，不影响学校授权；跨账号、学校隔离，手填偏好和当前明确表达优先。
- 删除/清空/开关提高generation，包含旧记忆的任务在每批和接受结果时失效，旧问答不重新进入上下文或把已删记忆恢复。
- 所有模型写入都经服务器白名单校验；不保存密码、密钥、证件号码、联系方式等；“不要记住”当轮不提取。UI无确认弹窗，只有查看、删除、清空和开关。
- 当前无真实模型凭据，测试只证明接线/校验；主分支和部署不在范围，继续AI_module。

## Task 1: 存储与校验（子智能体 memory_store）

Files: apps/cloud/src/assistant-memory.ts, apps/cloud/tests/assistant-memory.test.ts.

Interfaces: export memoryService(db, repo, now=Date.now) => {get(owner,schoolId):Promise<AiMemoryState>, handle(action,input,identity), apply(owner,schoolId,{requestId,question,proposals,generation,observedAt}):Promise<number>}。候选类型 export MemoryProposal {slot:AiMemorySlot;text:string;evidence:string}。snapshot get 不创建空行；写入 seed+atomic，保留既有字段和其他学校。

- [x] 先失败测试：默认开；可信身份/学校隔离；逐字来源、类型/长度、非必要/假设/密钥拒绝；幂等、更新不倒退、到期、忘记后旧回调不复活。
- [x] apply 只接内部调用，程序保存恰当候选，按requestId记账最近40次；observedAt早于该槽updatedAt时不覆盖，期限按observedAt算，过期候选不复活。支持稳定自动纠正，每次实际变化version+1。
- [x] handle仅get/configure/forget/clear，version冲突返回 MEMORY_CONFLICT；forget/clear/configure提高generation，version+1；关闭保留条目供查看，但不使用和写入；不改变其他用户偏好。
- [x] 运行node:test，报告先失败后通过证据；不修改共享文件或提交。

## Task 2: 页面管理（子智能体 memory_ui）

Files: apps/web/src/components/AssistantPanel.vue, apps/web/tests/assistant.test.ts.

Interfaces: 新contract AiMemoryState；actions ai.memory.get/configure/forget/clear。get输入schoolId；configure额外enabled/version；forget额外id/version；clear额外version。返回最新state。

- [x] 先失败组件测试：展示默认自动保存说明、条目，删除/清空无确认提交、开关、账号/学校切换丢弃旧返回，冲突重新读取。
- [x] 增加“AI记住的信息”折叠区，独立于行为学习；自动模式无需确认，每条可删除，显示阶段到期；完成回答/恢复读取后刷新记忆。
- [x] 沿用epoch和mutation，无新后台轮询，无密钥持久化；清空不宣称删除手填偏好；更新fakeTransport覆盖新get。
- [x] 运行组件测试，报告结果，不改合同/云端/文档、不提交。

## Task 3: 模型与对话接线（主智能体）

Files: apps/cloud/src/ai-service.ts, assistant-chat.ts, assistant-service.ts, chat-context.ts, gateway.ts; new memory-output.ts and tests; docs/ai-reading-guide.md, sync tool, generated chat-guide.ts.

- [x] 测试先行：真实执行器调用含记忆规则；同一次模型回复隐藏块被剥离并自动存，下一会话含记忆；非法/失效/取消/禁用/删除竞态不写，配额仍1轮。
- [x] 隐藏格式固定 `<!--campus-memory {"items":[{"slot":"goal","text":"我想积累项目经验","evidence":"我想积累项目经验"}]} -->`；默认允许空items或省略。解析只在对话最终汇总收候选，畸形块丢候选且去除，不影响正常回答；正文仍经引用校验。
- [x] ChatContext.memory={enabled,generation,items:[{id,slot,text}]}；从服务端读取，独立于3500历史预算（最多6*180字）。最终成功Task存memoryProposals；publicTurn读取完成任务后apply，get generation防删后复活；跨会话无原始正文历史重放。
- [x] ai-service每次load核对memory generation/开关，旧任务失效；清除任务候选随24h清理一起删。只扩展内部chat参数，gateway不允许伪造候选/身份。
- [x] 推荐可使用自动interests/goal作次级依据，手填优先；其余槽不参与资格推断。

## Task 4: 验证、审查与上传

- [x] 同步 README/设计/指南/PROGRESS，说明默认自动、期限、管理和未实测边界；原先“确认保存”提议标为被替代。
- [x] npm ci、ai:guide:check、typecheck、全量测试、build、netlify:build。
- [x] 独立非Astra审查；neat-freak知识收尾，保留原始工作区，不写个人记忆、不清场。
- [ ] 核实真实AI_module、远端基线及无队友覆盖后普通推送；不合并main、不部署。
