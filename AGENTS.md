# 项目工作约定

- 本项目是 Vue 3 / TypeScript 校园公告网站；当前主业务后端为 Netlify Functions、Identity、Database，CloudBase 代码保留兼容。
- 用户负责 AI_module。首次选校引导、离线推送由队友负责，不擅自实现或改动其职责范围。
- 允许子智能体协作；使用 SDD 时不得使用 Astra。进度、验证结果和待接入事项持续写入根目录 `PROGRESS.md`。
- 开始前遵循全局 using-superpowers 工作流；变更先读 README 和 `docs/ai-reading-redesign.md`。
- 运行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`；Netlify 完整函数产物另运行 `npm run netlify:build`，该命令只构建，不发布。
- 修改 `docs/ai-reading-guide.md` 的模型指令后运行 `node tools/sync-ai-guide.mjs`，再运行 `npm run ai:guide:check`。
- AI 新对话与旧高级任务共用官方日账户。保留幂等、预占和状态不明暂停，不为新页面重置额度。
- 所有资料在读取、每批发送及接受结果前校验账号/学校/来源许可；搜索摘要不冒充正文，搜索重导入不得绕过既有来源策略。
- 密钥仅通过服务端环境变量配置，不写入 VITE_、代码、日志、文档示例或对话。不得将测试夹具加入生产数据。
- 数据库变更使用独立迁移，不在函数请求内建表；合入当前 main 时，对话集合迁移为第八份 20261022000100_ai_conversations.sql，部署时应用，原七份不改。
- 类型检查、单测、模拟浏览器、真实模型调用和生产发布是不同证据层次，分别报告。
- 当前交付目录曾没有 `.git`；进入 Git 操作前重新确认真实检出和 AI_module 分支，不自行初始化、推送或部署。
