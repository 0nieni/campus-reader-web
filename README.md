# 校园阅览室

面向受邀用户的校园公告、收藏与 AI 阅读网站。Vue 3 + TypeScript + Netlify Functions、Identity 和 Database。代码仓库保持私有，各账号的数据独立。

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

服务端环境变量：NETLIFY_OWNER_EMAIL（初始账号邮箱，用于保留原工作区归属，不是成员白名单）、AI_CHAT_API_KEY（DeepSeek Key）；可选 AI_CHAT_BASE_URL、AI_CHAT_MODEL、AI_DAILY_LIMIT、AI_PLATFORM_DAILY_CALLS、AI_PLATFORM_DAILY_TOKENS。全部通过 Netlify 环境变量配置，不能加入 VITE_ 变量或提交到 Git。

Identity 保持 Invite only，管理员通过控制台邀请其他用户。正式站点允许访问登录页，预览可继续私有。每个可信 Identity UID 独立保存学校偏好、收藏、私人资料、AI 任务和每日五次额度。原始账号继续使用现有数据；不要为新增成员更改 NETLIFY_OWNER_EMAIL。DeepSeek 账单与平台总调用预算仍由站点共同承担。

AI 默认每日 5 次、北京时间零点重置。任务正文满 24 小时拒读、访问时清理，每天北京时间 02:17 定时兜底清理，无人访问时不保证第 24 小时准点物理删除。

两份迁移包含新站表结构与 5 个公开来源、27 条公告的有限导入，不含私人邮件、旧 AI 任务或账号密码。原 CloudBase 适配代码保留作兼容参考，Netlify 业务入口使用独立 SQL 存储；自动采集、邮件、提醒等后台尚未迁移。

DeepSeek API 单独计费；Netlify Free 的计算、流量和部署使用共享额度，不承诺无限免费。

## 学校目录与申请

新增第三份独立迁移：导入用户提供的 115 所高校（39 所标注 985），保留 bjtu 编号和旧资料。登录加载完整目录并可搜索；选校/刷新按需读取该校公开公告，共享缓存一小时，失败五分钟冷却。正文按需读取，附件不自动读。需登录、校园网或未知结构的来源会明确提示并保留原站入口，不保证所有学校均可公开采集。

未找到学校时可填写全称提交申请。服务端从真实 Identity 会话取邮箱，校验校名、每账号每天最多三所、同日同名防重发。正式站点通过 Netlify Forms 转发通知，预览不发送。开启 Form detection，部署识别 school-add-request 后，在 Forms > Submission notifications 为此表单添加 Email notification，收件邮箱 ninie6159@gmail.com；无需 SMTP 密码或新 Key。静态定义 apps/web/public/__forms.html 的字段须与服务端 URL 编码 POST 一致。提交被接受不等同于邮件送达；缺少合法申请时先查 Spam，不关闭过滤。

## 个人公告标签

分类默认七项全选，命中任意已勾选标签才展示；全不选时不展示公告，修改勾选即时筛选，重置恢复全选。公告详情中的“修改公告标签”支持为本人选择一个或多个现有标签、保存和恢复默认。个人标签独立存储在 campus_notice_labels，不修改原始公告的访问分类；原始邮件/私人资料权限继续使用服务端来源元数据。列表在分页前按本人有效标签筛选，收藏同步显示本人标签；重新采集不会覆盖个人标签。不影响其他账号或原 CloudBase 项目。第四份迁移由 Netlify Git 部署应用。

## 公开学校来源补充

34 校补充或替换公开栏目，北大使用教务部通知，清华接入公开院系通知和学术活动。选校后可展开查看实际栏目、覆盖范围、列表读取状态和原文入口；不代表学校全部校内公告已接入。修复公开正文容器、常见CMS链接/日期和导航误判，多来源部分成功可保留，版本更新自动刷新旧缓存。无需新迁移或环境变量。验证范围和限制见 [接入说明](docs/school-source-improvements.md)。

## 公告优先加载

数据库公告与学校目录、官网刷新并行；已有公告先读，变化由用户点击应用，正文和已读分页保留。当前UID内存缓存按学校/筛选分键，五分钟失效，退出/账号变化/重连清空，不写浏览器存储或共享CDN。既有每日02:17清理任务优先清理，再最多预采集三所近期使用学校；不新增每小时保活或迁移/环境变量。实现、验证和限制见 [加载优化](docs/feed-loading-performance.md)。
