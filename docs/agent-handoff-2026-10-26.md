# 校园阅览室项目交接（2026-10-26，北京时间）

这份文档记录用户已确认的要求、代码现状与验证边界。它是交接资料；新对话仍以用户的新请求和当前 AGENTS.md 为准，不把文档中的历史待办自动当作新增授权。

## 1. 正确目录、仓库与正式站点

- 保存的 Codex 项目根目录：`C:/Users/ter56/Documents/ChatGPT/project`。
- **本轮真正开发、测试、提交的 Git 检出**：`C:/Users/ter56/Documents/ChatGPT/project/.github-staging/ai-provider-profiles-20261024`。所有 npm/Git 命令应显式使用这个目录。根目录混有参考文件、旧副本和其他工作，不要在根目录初始化仓库或全量暂存。
- 私有仓库：<https://github.com/0nieni/campus-reader-web>。
- 正式网站：<https://campus-reader-ninie6159.netlify.app/>。
- Netlify site 名：`campus-reader-ninie6159`；site ID：`343589cf-9fb4-406b-a0d1-7e4af87a5dc1`。
- 用户自有域名为 `campusreader.online`，购自腾讯云。目前明确用于发信子域 `notify.campusreader.online`；未核验网站已绑定根域名，不能声称自有域名网站已上线。
- 当前功能分支：`codex/notice-title-excerpts`；实现提交 `78b38a0016bc545d4df15b844eb9d1afb9303be2`，已推送。
- PR #21：紫色登录/公告、邮箱注册、个人工作区，已合并，main 合并提交 `9b690e4a419d1cd1ef24bbb7f1f4175f158bbcdf`，正式入口已验证。
- PR #22：真实公告标题与正文摘录，已通过预览并合并；合并提交 `91d90ed02774b90eb8f7ac82f39be71c9691fa44`。最终部署核验结果在本文末尾追加。
- 发布采用正常 GitHub PR → Netlify 预览 → 合并 main → 正式部署。用户已明确授权“上线”，不要让他重新确认同一发布。新任务超出范围、真实邮件/模型收费等仍按用户新授权处理。

## 2. 用户要求与合作约定

1. 复杂任务先给可实现选项并澄清具体想法；目标和方法不明确时询问。范围明确的小修直接执行。
2. 任务无法完成或效果不好、现有技能不适用时，优先使用 find-skills 或 LobeHub 搜索适合技能；不要仅凭关键词乱装技能。
3. 保持 GitHub 私有，不自行升级套餐、购买服务或开自动续费。此前 Netlify 免费套餐不能单选 Functions scope，不需要为此付费；用套餐允许的 All scopes，服务端变量不加 VITE_。
4. 双方协作者都可审核和上线；保留其他人的工作、来源管理、学校接入、提醒及 AI 功能。用户重点负责 AI_module；队友维护首次选校/离线推送，不擅自扩展队友范围。
5. 所有账号独立保存学校、收藏、标签、私人来源、模型 Key、提醒和 AI 对话。保留账号/学校/来源授权及撤权复核。
6. **禁止恢复免费自动 AI 摘要。** 用户明确取消该功能；主动 AI 阅读每账号每天3次，按北京时间重置，旧高级任务和新对话共用同一日账户。保留预占、幂等和结果未知暂停，不自动换服务或重试来重复计费。
7. 最新 B 处概括已明确选择“正文摘录，免费且不消耗 AI 次数”；只引用已有正文，不调用模型、不自动批量抓取。
8. 不读取/输出密钥、密码、Cookie、CLI令牌、其他用户私密记录或 Netlify Forms 提交。历史审批曾拒绝 Forms 读取，不绕过。
9. 不随意新建 goal、子智能体、工作树；用户要的是新对话交接，不是让多个聊天同时修改同一检出。

## 3. 技术结构与先读文件

Vue3 + TypeScript + Pinia；`apps/web` 前端，`apps/cloud` 业务服务、数据库接口和测试，`packages/contracts` 共享契约。主后端为 Netlify Functions + Identity + Database，资料原文件使用 Blobs；保留 CloudBase 兼容实现，不修改旧小程序参考项目。

在真实检出中先读 `AGENTS.md`、`README.md`、`PROGRESS.md`，随后按任务读：

- `docs/ai-reading-redesign.md`、`docs/ai-reading-guide.md`、`docs/ai-memory.md`。
- `docs/ai-provider-profiles.md`、`docs/cc-switch-provider-analysis.md`。
- `docs/account-settings-2026-10-25.md`、`docs/template-theme-registration-2026-10-25.md`。
- `docs/aliyun-reminders-setup.md`、`docs/aliyun-reminders-verification.md`。
- `docs/lexmount-collection.md`、`docs/material-archive.md`、`docs/pr14-migration-history.md`。

文档含很多“尚未上线”的历史阶段，**以最新 PROGRESS、实际 GitHub/Netlify 状态为准**。不要仅凭旧文档重复实现或撤销已上线功能。

## 4. 用户确认的界面与交互

### 紫色模板

用户要求完整照搬最新 `login(1).html`、`index(1).html` 的风格，配色也不能变。原始文件在腾讯微信文件目录 `C:/Users/ter56/Documents/Tencent Files/微信聊天存储/xwechat_files/wxid_qcxdm9t7vscl22_8b90/msg/file/2026-10/`；早期绿色 `review.html` 已被最新紫色方案替代。

`apps/web/src/template-login.css` 和 `template-portal.css` 保存原始模板字节，`.gitattributes` 用 -text 保持原样；适配写在 `template-bridge.css`，旧功能样式在低优先级 legacy layer。页面只注入当前模板样式，避免全局污染。

- login CSS SHA256：`b65c4787d185f8eec7a7fe689e641c2be70a60219401d2e4251aecefbe96a189`。
- portal CSS SHA256：`6534e550cdb6bbbc0ed004db1790020a31321163a7c80fe7ae208d95da4fd206`。
- 主紫色 #7250bc、深紫 #392567、背景 #f8f7fb、正文 #292536；没有绿色或深色主题切换。

### 已实现行为

- 密码隐藏时闭眼、显示时睁眼，有按下反馈及 aria-pressed。
- 公告完整标题自动换行；“加入ai搭子”仅加入资料列表并继续浏览，不立刻生成回答；最多8篇、去重。旧右侧“用于 AI 阅读”复选框已删。
- 个人工作区固定在侧栏底部，短屏、长列表、手机收起侧栏均可见并可点击。侧栏贴住顶栏下方，菜单内部独立滚动；桌面顶栏84px，800px及以下70px。
- 点击个人工作区打开弹窗：显示用户名，账号安全/我的学校/服务模型三项。
- 更换密码采用**给当前账号邮箱发重置邮件**；不提供客户端任意指定收件人。
- 选校、学校搜索/分页/申请/覆盖范围已移到个人弹窗；公告页移除原选校栏，保留关键词/分类/时间筛选。
- 个人模型配置可在弹窗和 AI 阅读“服务模型调整”修改；保存和启用分开，配置变化同步到已打开的对话，不清空对话、不重置额度、不自动发问题。

## 5. 邮箱注册、密码重置与模型密钥

### Identity

用户选择“邮箱注册并验证后自动开通”。用户已亲自把 Netlify Identity Registration 改为 Open，并保持邮箱验证开启；本轮公开 settings 复核 `disable_signup=false`、`autoconfirm=false`、`email_enabled=true`。

注册/恢复令牌从 URL 移除后仅驻留内存；未完成认证不加载工作区；新密码12至256字符，提交后清空。密码恢复要校验 Identity SDK 用户 UID 与服务端会话一致，失败清理部分登录会话。重置邮件 API 同源、需要登录，收件人来自受信任会话。

**未做真实新用户收信→点击确认→登录全流程，也未发送真实密码重置邮件。** 模拟传输和真实公开界面检查不代表真实送达。

### 个人服务商

按用户要求分析 CC Switch 的配置保存/选择思路，落实为每账号独立保存，不共享 Key。支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini 四种协议；保留官方 AI 与仅页内存临时 API。最多10套配置、每套20模型。Key 不回显、不写浏览器 Storage。

服务端 AES-256-GCM 加密保存。`AI_PROVIDER_ENCRYPTION_KEY` 已在 Production 使用 Netlify secret 安全设置；先确认不存在才生成，未打印、写本地或入库明文。**后续不要重新生成或覆盖它**，否则已有 Key 不能解密；没有在线轮换工具。当前文档只记录变量名，不包含值。

选中项影响后续新轮次；在途任务固定配置版本，配置删改时停止过期版本结果；状态不明不自动重发。个人 API 不扣官方日次数，不会失败后自动改用官方。

**真实服务商端点、模型响应质量、计费及已保存Key端到端联调尚未实测。**

## 6. 提醒链路与阿里云配置进度

用户原先接受每天09:00/20:00兜底，后来要求网页关闭也按设定分钟提醒，选择 QStash，最终明确按阿里云计划改成 FC 调度 + DirectMail + Web Push。当前代码采用阿里云；不要重新要求配置 QStash。

- FC 每分钟签名调用 `https://campus-reader-ninie6159.netlify.app/.netlify/functions/reminder-tick`。
- FC 只需要 `REMINDER_TICK_URL` 和 `REMINDER_TRIGGER_SECRET`，代码为 `infra/aliyun/reminder-tick.cjs`；Node20+，入口 index.handler。
- 网站用 Blobs 下一唤醒索引避开空闲 SQL；任务版本、通道回执、租约、限次和结果未知规则保持不变。
- 站内提醒/日历、浏览器、邮件各自独立；邮件默认关闭，账号开启后还需逐篇明确选择；每篇公告单独设置时间，不做用户未要的批量时间方案。
- “学校与关键词”页签已按用户要求移除。提醒中心右侧选择公告，有关键词、标签筛选与勾选加入；全部提醒时间在提醒中心设置。
- 公告卡/详情的加入提醒入口保留；原摘要操作改为加入ai搭子。
- 发信域 `notify.campusreader.online` 的 DKIM/SPF/DMARC/MX 用户截图均验证通过；发信地址 `reminders@notify.campusreader.online` 状态正常。
- 用户已创建RAM用户、策略、授权，配置邮件5项和调度变量，创建FC并自认配置无误。此前截图有 FC accepted:true、定时日志 status204；**这不是本轮现场复验，也不能等同邮件/设备成功收到**。
- Netlify变量：`REMINDER_SCHEDULER=aliyun-fc`、`REMINDER_TRIGGER_SECRET`、可选NEXT、`DIRECTMAIL_ACCESS_KEY_ID/SECRET`、`DIRECTMAIL_REGION=cn-hangzhou`、`DIRECTMAIL_ACCOUNT_NAME`、`DIRECTMAIL_FROM_ALIAS`、`REMINDER_EMAIL_ENABLED`、`REMINDER_EMAIL_DAILY_LIMIT`。已有 `WEB_PUSH_PUBLIC_KEY/PRIVATE_KEY` 保留。
- KEY、SECRET、签名私钥应使用 secret；显示名/地区/开关/上限是普通配置。Production-only，不把生产密钥复制给预览。
- **当前未复核邮件开关实际值、当前FC心跳、真机分钟推送或真实邮件送达。** 后续可在用户授权后逐通道验收。服务商接受不等于收件箱/系统弹出；iOS需主屏幕网页应用。

## 7. 其他已合并功能，需保留

- 来源中心与按账号选择主页显示来源，筛选在 SQL 分页之前；学校、竞赛、私人来源隔离；无需显示来源不代表撤销已授权阅读。
- Lexmount 采集代码已上线；只向官方 CN/COM Web Fetch 接口发公开 URL，保留 robots、公网地址、范围、大小和超时限制。RSS/JSON、robots、二进制附件沿用各自受限读取。
- `LEXMOUNT_API_KEY`、`LEXMOUNT_PROJECT_ID` 和匹配区域入口需由所有者安全确认；本机技能登录不代表 Netlify 凭据可用。本轮未重新核验 Production 真采集。
- 资料库 Database + Blobs 保存正文及PDF/Word/Excel原文件365天，固定有效期、权限复核、未提取格式诚实提示，无OCR。
- AI 长期记忆、近期上下文、公开全网资料搜索/明确主题、Tavily可选、引用和个人偏好已保留；真实模型重要性判断及真实搜索收费接口本轮未调用。
- 自动采集/清理/调度原有日任务不另建无限唤醒；不替换 `MATERIALS_JOB_SECRET` 等既有密钥。

## 8. 最新 A/B 标题与摘录修复细节

用户截图“研究生招生”“通知公告”“本科生教育”等并非应删除的假公告：早期导入已有正确正文与文章URL，但标题存成栏目名称。20篇BJTU计算机学院文章均直接读取官方公开URL并核对元数据标题；未用付费 Lexmount/AI、未导入QA数据。

- 新增 `20261026000200_verified_notice_titles.sql`，三条历史字节相同；只匹配公共源 `15ff78a66acb889d000bcdb945e4c113`，以及每条ID、URL、旧标题，排除私有所有者。保留正文、日期、ID和其他字段，重复运行无变化。
- 例：`1233ab626acb88ba001caa471772eda6` 从“研究生招生”修正为“2027年候补推免考生位次更新情况。”，原URL保留。
- `apps/cloud/src/notice-excerpt.ts` 从已有 contentText 取最多120字，去重复标题和常见发布时间行；不读旧 summary/autoSummary，失效的 materialExpiresAt/aiSearchExpiresAt 不回显。
- `gateway.toNotice` 加可选 excerpt；原 summary:null 保持。列表仍经账号/学校/来源和保留期校验后映射，不额外抓取正文。
- `App.vue` 标签/来源下方显示“正文摘录：…”；没有正文显示“尚未读取正文，打开公告后可查看摘录。”，打开详情后同步列表标题与摘录并保留异步作用域检查。
- `school-pages.extractArticleTitle` 使具体文章元数据优先于通用栏目h1；用于 html_detail 后续解析，降低复发。
- 真实标题核验清单、合成浏览器、截图和原始响应只留在忽略目录 `.github-staging/qa-theme`，不加入发布产物。

## 9. 数据库迁移与验证流程

不能修改已经应用迁移的名字、字节或登记状态。正式和新分支用 `netlify/database/migrations`；旧AI_module预览用 `pr14-migrations`；旧 `codex/ai-companion-model-settings` 预览用 `pr17-migrations`。

PR14的AI对话迁移历史早于正式；PR17的provider迁移早于资料库，所以PR17以 `20261026000100_collected_materials.sql` 追加资料库。不要“整理文件名”造成倒序，不重置预览库。新迁移版本大于三条历史最大值；兼容目录同步并验证收敛。

生产数据修正用提交的 DML迁移，走部署应用；不直接连接托管数据库操作，不读取CLI令牌、抓内部API、运行schema push或修改迁移表。Netlify命令/部署失败要保留准确错误、站点分支和日志链接，按适用skill处理，不降级绕过。

项目要求 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`、`npm run netlify:build`；后者只构建，不发布。最近依赖锁未改，安装已在发布前完成。修改模型指南后须同步 `tools/sync-ai-guide.mjs` 并验证。测试用真实本机SQL及合成账号，不在生产写夹具。

最新验证：228前端+375后端=603项测试全通过；类型/指南/普通构建/11函数完整构建通过。迁移三历史验证标题修正、幂等、原正文和私人记录保留。桌面1413×871/手机390×844共15项合成浏览器检查通过，无运行错误和横向溢出。

PR21另有599项测试、4尺寸20项侧栏检查、正式登录/注册7项浏览器检查。各层证据不混用：单测和模拟浏览器≠真实模型/邮件≠正式发布。

## 10. 新对话接手后的范围

先读取此文档及真实检出的当前状态，简短确认理解，等待用户下一个任务。若本文末尾明确记录尚未完成的发布核验，只继续那项已授权收尾。不要擅自发真实邮件/邀请、调用付费模型、轮换密钥、修改DNS、购买或扩展功能。

后续可让用户按需要选择真实联调：新用户验证/重置邮件，个人模型保存调用与切换，Lexmount线上采集，FC分钟心跳及浏览器/邮件到达。它们是验收建议，不是现在自动执行的工作单。

## 11. 最终发布核验补记

PR22生产部署已完成。官方Netlify CLI watch正常结束并返回正式网站URL；正式首页HTTP200，主资源 `/assets/index-Dd7tKUTP.js` 与已核准预览完全一致，资源包含正文摘录及缺正文提示。`origin/main`已同步为合并提交 `91d90ed02774b90eb8f7ac82f39be71c9691fa44`。

正式浏览器7项登录/注册检查全部通过，无运行错误；没有登录真实账号或读取生产公告数据。未登录auth返回200/no-store，公开Identity仍为disable_signup=false、autoconfirm=false。标题迁移的实际数据正确性由三历史本机SQL测试覆盖，托管端通过正常部署迁移；没有直接查表逐条验收生产记录。

功能任务已经完成，不再有必须继续的开发/部署步骤。当前分支随后仅补充交接/进度文档，代码与正式发布实现一致；新对话应先核对Git状态，不因分支含文档收尾提交而重新部署。真实邮件、模型、Lexmount凭据与设备推送仍保持前述待联调状态。
