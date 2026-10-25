# Lexmount 采集接入

用户已确认：网站后台自动采集改用 Lexmount，继续使用现有资料库；在 `lexmount的应用` 新分支保存并推送到 GitHub，本次不合并、不上线。

- [x] 使用已安装的 lexmount-webfetch 技能完成公开网页实测；后台按官方 Web Fetch HTTP API 接入，不把 Windows CLI 或本机登录文件上传到 Netlify。
- [x] 公告列表及正文用 `/v1/dom/dump` 获取渲染后的 HTML，沿用学校/来源白名单、列表日期解析、附件发现、正文校验及权限检查。仅发送公开 URL，不发送登录 Cookie、账号资料或模型密钥。
- [x] 校验配置、输入/最终 URL、公网 DNS、API 状态及目标状态；限制响应大小与总超时；鉴权、配额、区域、超时错误给出明确结果，不重复调用或暗中切回旧 HTML 采集。
- [x] robots、RSS/JSON 原始数据及二进制文件保持各自协议读取规则；网页获取接入 Lexmount，已保存文本和 365 天清理不变。
- [x] 02:45 后台任务使用相同采集适配器。02:17 清理只做现有 AI/提醒清理，原公开列表预热由 02:45 任务覆盖，避免在 30 秒清理任务中重复启动渲染采集。AI 搜索提供商及其临时证据链、提醒调度不改。
- [x] 增加接口与本机 SQL 集成回归，完成 npm ci、typecheck、全部测试、普通构建和 Netlify 完整构建。
- [x] 更新说明与进度，明确真实技能调用、本机模拟服务集成和未发布的区别；提交并推送指定新分支，不改生产环境变量。

官方接口参考：[Dump DOM](https://browser.lexmount.cn/docs/webfetch/reference/dump-dom)、[错误处理](https://browser.lexmount.cn/docs/webfetch/reference/common-errors)。本机技能检查已报告 `ok: true`，credentials / agent_skill 均通过。

## 验证完成（2026-10-25）

技能实际采集北京大学教务部公开公告页成功，HTTP 200，lightmount_dcl，19175 字符；本地回放到新适配器和原解析器识别 15 条公告，没有写入生产。新增接口/本机 SQL 测试验证入库、附件、权限、缓存、原始协议和超时/额度错误。

npm ci、typecheck、521 项测试（web 186 / cloud 335）、普通构建、11 函数 Netlify 完整构建通过。没有修改 SQL 迁移、提醒实现或 AI 搜索链。远端保存为最后交付步骤，完成后单独记录；不合并、不发布、不修改生产凭据。

## 远端保存

实现提交 e3fb21406af48b4f637c7dd785ac6633e4c0df9d 已推送到 GitHub 的“lexmount的应用”分支，git ls-remote 返回的远端 SHA 与本地一致。没有创建 PR、合并 main、修改生产凭据或主动发布。此交付记录随后作为同分支文档提交同步。

## 合入 main 与发布授权（2026-10-25）

用户后续明确要求合入 main、应用到现有网站，并确认只发布已完成的 Lexmount 采集功能，保留 main 最新改动，提醒与 AI 搜索保持现状。此授权覆盖上文仅保存分支、不发布的阶段限制。发布前重新核对远端、运行规定的依赖安装/类型检查/测试/完整构建；发布结果和待用户配置事项持续记录到 PROGRESS.md。生产 Lexmount 项目凭据由所有者在 Netlify 安全配置，不读取或复制本机技能凭据。

执行结果：本轮 521 项测试、类型检查及两种完整构建通过；PR #19 预览成功后合入 main 的 286bbf2，Netlify 正式部署 6addee806a4eac4036f4a4ee 已 ready，代码版本吻合。网页返回 200，正确 Origin 的未登录 API 返回 401 / no-store。密钥配置及真实采集仍待所有者操作后联调，详细记录见 PROGRESS.md。
