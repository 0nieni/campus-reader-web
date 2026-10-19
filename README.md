# 校园阅览室

面向受邀用户的校园公告、收藏与 AI 阅读网站。Vue 3 + TypeScript + Netlify Functions、Identity 和 Database。代码仓库保持私有，各账号的数据独立。

## AI 阅读助手（本地实现，尚未部署）

“AI 阅读”现在默认进入对话页面：本校公告卡片、可修改的兴趣与目标、连续追问、原文引用、对话导出和显式联网搜索。官方每天最多三轮成功模型回复，北京时间零点重置；内部资料分批与汇总共计一轮。新对话与高级阅读共用已有日账户，不重复赠送额度；状态不明时暂停并保留预占，可查询、取消及核查结算。高级入口保留旧资料预览、MD/JSON 导出及 v1 报告，不提前删除旧任务。

推荐使用本校最多 200 条已有公告，明确兴趣优先，点击与收藏辅助；行为学习默认关闭，开启后仅使用近 30 天信号，支持清除及“不感兴趣”撤销。保存偏好会更新推荐。打开推荐、搜索和刷新不调用模型、不扣官方次数，搜索服务本身仍可能计费。对话从会话创建起 24 小时到期，不因追问续期；明确兴趣保存至修改或清除。每日清理任务增加对话、临时搜索正文及最多 200 份用户档案的轮转清理，不新增定时器。首次选校引导与离线推送仍由队友负责；本模块读取统一选校记录，提供服务端 `notificationCandidates` 交接能力，不发送通知。

联网搜索使用可选服务端 `TAVILY_API_KEY`，通过 [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) 搜索所选学校的官方域名；每账号每天最多 20 次、至少间隔 15 秒。最多五条候选、最多读取前三条正文；缺少 Key 或失败时明确提示并保留已有公告。搜索摘要不作正文证据，新候选不自动订阅，取得的临时正文按账号和学校隔离、24 小时到期。已知链接复用公告 ID 与全部来源许可，核验达到 200 条且仍未匹配时仅展示只读线索。临时结果用于显式选入对话，不进入后续自动推荐。真实搜索及模型联调需要部署后的有效凭据，当前不声称已完成线上验证。

对话 v2 指令由 [对话式阅读指南](docs/ai-reading-guide.md)生成，修改后运行 `node tools/sync-ai-guide.mjs`；`npm run typecheck` 会校验一致性。产品分工、接口与验收见 [重做方案](docs/ai-reading-redesign.md)，最新进度和验证状态见 [PROGRESS.md](PROGRESS.md)。新增第五份迁移 `20261019000100_ai_conversations.sql`，上线前必须由正常部署应用；本地实现不等于线上发布。

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

将此私有仓库连接到现有 Netlify 项目，保留根目录 netlify.toml。Base directory 和 Package directory 均留空：这是包含网页、服务端函数和迁移的一个完整站点，不单独选择 apps/web 作为站点项目目录。构建命令为 npm run build --workspace=@campus/web，发布目录为 apps/web/dist，函数目录为 netlify/functions。全部 SQL 迁移位于 netlify/database/migrations，由平台在部署生命周期应用，不在网页或函数请求中执行建表。可先运行 npm run netlify:build 检查完整函数与网页产物，该命令不会发布。

服务端环境变量：NETLIFY_OWNER_EMAIL（初始账号邮箱，用于保留原工作区归属，不是成员白名单）、AI_CHAT_API_KEY（DeepSeek Key）；可选 AI_CHAT_BASE_URL、AI_CHAT_MODEL、AI_DAILY_LIMIT、AI_PLATFORM_DAILY_CALLS、AI_PLATFORM_DAILY_TOKENS、TAVILY_API_KEY（联网搜索）。全部通过 Netlify 环境变量配置，不能加入 VITE_ 变量或提交到 Git。

Identity 保持 Invite only，管理员通过控制台邀请其他用户。正式站点允许访问登录页，预览可继续私有。每个可信 Identity UID 独立保存学校偏好、收藏、私人资料、AI 任务和每日三次额度。原始账号继续使用现有数据；不要为新增成员更改 NETLIFY_OWNER_EMAIL。DeepSeek 账单与平台总调用预算仍由站点共同承担。

AI 默认每日 3 次、北京时间零点重置。任务正文满 24 小时拒读、访问时清理，每天北京时间 02:17 定时兜底清理，无人访问时不保证第 24 小时准点物理删除。

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

## 网站公告来源导入

“公告来源”支持新增、测试、采集、编辑、启停、移除网页列表/单篇、RSS/Atom和JSON公开接口。自定义来源及内容按账号与学校独立。普通浏览和采集不扣AI次数；不提供免费公告摘要，生成摘要、提纲和问答共用每日3次官方阅读额度（北京时间重置），仅主动开始才调用模型。详见 [网站来源导入](docs/website-source-import.md)。
