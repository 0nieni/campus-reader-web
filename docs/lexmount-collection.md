# Lexmount 采集分支

功能最初在 `lexmount的应用` 分支实现，基于已发布的“数据库”版本 `8b038d7`。用户确认将网站后台自动采集改用 Lexmount，保留现有资料库；2026-10-25 后续明确授权合入 main 并发布，覆盖此前仅推送保存的阶段限制。实际部署和凭据联调状态见 [进度记录](../PROGRESS.md)。

## 使用方式

开发时使用已安装的 `lexmount-webfetch` 技能验证公开网页。网站运行时按[官方 Dump DOM API](https://browser.lexmount.cn/docs/webfetch/reference/dump-dom)调用 `/v1/dom/dump`，不依赖开发电脑、Windows CLI 或本机登录文件。普通公开页面和需要 JavaScript 渲染的页面走 Web Fetch；本版无需创建可交互 Browser session，不自动登录或处理验证码。

选择 Dump DOM 是为了取得完整的渲染 HTML，继续使用已有的学校栏目、日期、正文选择器和附件链接解析规则。每次只调用一次接口，不再叠加 Extract 调用。返回的 HTML 快照在过滤脚本与样式后进入现有 Database / Blobs 资料库；这属于渲染快照，不等同于源站原始 HTTP 字节。Lexmount 的临时 `dom_id` 不作为一年保存的依据。

学校刷新、个人 HTML 来源、资料缺失时的按需正文读取，以及 02:45 的后台采集使用同一适配器。旧 02:17 清理函数中的短时公开列表预热移至已有的 02:45 采集任务覆盖，避免在 30 秒清理函数内重复进行渲染请求；AI 与提醒清理调用保持原样。

robots.txt、RSS/Atom、JSON 接口需要保留原始文本/XML/JSON，仍使用已有受限 HTTP 读取；PDF、Word、Excel 原文件继续使用原有受限下载器并本地提取文字。个人来源的 robots 限制、请求节流、每天 60 次请求预算、学校与账号权限、365 天固定有效期均保留。AI 联网搜索服务和临时搜索证据链没有改动；提醒的发送与调度实现没有改动。

## 运行所需配置

仅通过 Netlify 服务端环境变量设置：

- `LEXMOUNT_API_KEY`：目标 Lexmount 项目的 API Key。
- `LEXMOUNT_PROJECT_ID`：与 Key 匹配的项目编号。
- `LEXMOUNT_WEBFETCH_BASE_URL`：可选，默认 `https://api.lexmount.cn`；海外区域使用 `https://api.lexmount.com`，项目凭据需与区域一致。本版只允许这两个官方 HTTPS 根地址。
- `LEXMOUNT_WEBFETCH_ENGINE`：可选，默认 `auto`；支持官方的 `http`、`chrome`、`chrome_cdp`、`lightmount_lite`、`lightmount_dcl`、`lightmount_domstable`。

不要加 `VITE_` 前缀，不将密钥写入仓库、浏览器或日志，也不要复制本机技能凭据文件到站点。本机技能已登录不代表 Netlify 已配置上述变量。由项目所有者通过 Netlify 环境变量界面安全填写对应 Production 的服务端变量，并重新部署使其生效；无需将 Key 发送到聊天。若日采集已启用，保留原有 `MATERIALS_JOB_SECRET`，不要更换它或其他服务密钥。

未配置时 HTML 采集明确返回 `LEXMOUNT_NOT_CONFIGURED`，不会悄悄切回旧 HTML 抓取。已有有效资料仍可读取；JSON/RSS 等原始格式读取不依赖 HTML 渲染配置。配额、鉴权、区域、限流和超时均有独立错误提示。适配器不自动重发；后台队列仍沿用每任务每天最多三次尝试，不能将超时理解为服务商没有执行或计量。

Lexmount 的调用使用其服务额度，详情见[官方接口与用量说明](https://browser.lexmount.com/docs/webfetch)。不执行购买、升级或绕过额度限制。

## 校验边界

输入和返回的最终 URL 均校验公开网址、学校/来源范围及公网 IPv4 解析；不把浏览器 Cookie、Identity UID、聊天、模型密钥或账号资料发送到 Lexmount。服务接口仅接收公开 URL 和固定选项，请求凭据只发往官方接口，API 级重定向被禁止。云端渲染中的中间跳转及子资源请求由 Lexmount 执行，本地不能固定它的每个连接地址；最终 URL 或内容不合规则时不会入库。

同时校验 API HTTP 状态与目标 `status_code`；API 返回 200 而目标返回 403/404 时不算采集成功。缺少有效最终 URL、空 HTML、错误格式、超过 4 MiB 的 JSON 或超过 1.5 MB 的 HTML 均拒绝作为正文。服务端抓取处理时限 15 秒，客户端整个请求约 20 秒；页面内容仍经过原解析器校验，不能因为渲染接口成功就认定正文完整。失败仅返回固定、脱敏后的错误说明，不返回供应商原始错误体或密钥。

## 验证记录

- 技能检查：Windows WebFetch CLI 0.1.5，doctor 的 `ok`、credentials、agent_skill 检查均通过。
- 真实技能调用：对既有白名单中的北京大学教务部公告列表进行一次 Dump DOM，目标状态 200、引擎 `lightmount_dcl`，返回 19175 字符的 HTML。本地回放至新适配器和现有解析器识别 15 条公告；结果只留在本地忽略目录，没有导入生产数据。
- 本机集成：合成 Lexmount 响应经过学校采集、实际 SQL、附件提取与内存对象存储；验证资料保存、稳定 ID、有效期缓存、来源停用拒读，以及 robots / JSON 原始读取。接口回归覆盖官方请求格式、密钥脱敏、不安全 URL、错误区域、配额、目标错误状态、响应大小与超时。
- 真实 Netlify 运行环境中的 Lexmount 凭据、账户区域和采集联调尚未验证；本次只推送功能分支。
