# 校园阅览室

个人使用的校园公告、收藏与 AI 阅读网站。Vue 3 + TypeScript + Netlify Functions、Identity 和 Database。代码仓库保持私有，网站按本人邮箱白名单访问。

## 本地检查

需要 Node.js >=22.12。

```sh
npm ci
npm run typecheck
npm test
npm run build --workspace=@campus/web
```

本地 SQL 测试使用单进程 Postgres 兼容引擎，不代表远端负载验证；模型测试使用测试桩。Netlify 登录须在真实部署中验证。

## Netlify 构建

将此私有仓库连接到现有 Netlify 项目，保留根目录 netlify.toml。Base directory 和 Package directory 均留空：这是包含网页、服务端函数和迁移的一个完整站点，不单独选择 apps/web 作为站点项目目录。构建命令为 npm run build --workspace=@campus/web，发布目录为 apps/web/dist，函数目录为 netlify/functions。两份 SQL 迁移位于 netlify/database/migrations，由平台在部署生命周期应用，不在网页或函数请求中执行建表。

服务端环境变量：NETLIFY_OWNER_EMAIL（本人邮箱）、AI_CHAT_API_KEY（DeepSeek Key）；可选 AI_CHAT_BASE_URL、AI_CHAT_MODEL、AI_DAILY_LIMIT、AI_PLATFORM_DAILY_CALLS、AI_PLATFORM_DAILY_TOKENS。全部通过 Netlify 环境变量配置，不能加入 VITE_ 变量或提交到 Git。

Identity 需要启用并设为 Invite only。先验证预览分支迁移和真实数据，再发布主站；仓库上传成功不等于网站或数据库已上线。当前手工 CLI 预览缺少迁移构建步骤，Git 云端构建是否解决仍需实际验证。

AI 默认每日 5 次、北京时间零点重置。任务正文满 24 小时拒读、访问时清理，每天北京时间 02:17 定时兜底清理，无人访问时不保证第 24 小时准点物理删除。

两份迁移包含新站表结构与 5 个公开来源、27 条公告的有限导入，不含私人邮件、旧 AI 任务或账号密码。原 CloudBase 适配代码保留作兼容参考，Netlify 业务入口使用独立 SQL 存储；自动采集、邮件、提醒等后台尚未迁移。

DeepSeek API 单独计费；Netlify Free 的计算、流量和部署使用共享额度，不承诺无限免费。
