# CC Switch 服务商配置源码分析与应用

分析日期：2026-10-24；本站实现验收：2026-10-25（北京时间）。

用户指定 `reverse-engineer-anything`。按该技能对完整开源源码的分流规则，本次使用普通源码工具，未运行 CC Switch、读取其个人配置或反编译安装包。结论只适用于下面固定提交，不宣称与某个已安装版本一致。

## 固定来源与证据

官方仓库：[farion1231/cc-switch](https://github.com/farion1231/cc-switch)，固定提交 `cae7c375405f509a8c1fe96ab47cfeb55b885945`，许可证 MIT。本站按职责重新实现，未复制桌面应用的配置目录、代理或账号凭据。

- 配置作为独立对象维护，前后端有明确的增删改与切换接口：[类型](https://github.com/farion1231/cc-switch/blob/cae7c375405f509a8c1fe96ab47cfeb55b885945/src/types.ts#L12)、[前端 API](https://github.com/farion1231/cc-switch/blob/cae7c375405f509a8c1fe96ab47cfeb55b885945/src/lib/api/providers.ts#L88)、[Rust Provider](https://github.com/farion1231/cc-switch/blob/cae7c375405f509a8c1fe96ab47cfeb55b885945/src-tauri/src/provider.rs#L11)。
- 保存和启用可以分开，新增路径有 `add_without_switching`；切换前检查目标并取得锁：[服务层新增](https://github.com/farion1231/cc-switch/blob/cae7c375405f509a8c1fe96ab47cfeb55b885945/src-tauri/src/services/provider/mod.rs#L5590)、[切换路径](https://github.com/farion1231/cc-switch/blob/cae7c375405f509a8c1fe96ab47cfeb55b885945/src-tauri/src/services/provider/mod.rs#L6791)。
- `set_current_provider` 在事务中清除旧当前项并设置新当前项：[DAO](https://github.com/farion1231/cc-switch/blob/cae7c375405f509a8c1fe96ab47cfeb55b885945/src-tauri/src/database/dao/providers.rs#L475)。网站借鉴这一职责分离，采用按账号的当前选择和版本控制。
- 桌面存储的 `settings_config` 是 SQLite TEXT，保存路径直接序列化 JSON：[schema](https://github.com/farion1231/cc-switch/blob/cae7c375405f509a8c1fe96ab47cfeb55b885945/src-tauri/src/database/schema.rs#L27)、[写入](https://github.com/farion1231/cc-switch/blob/cae7c375405f509a8c1fe96ab47cfeb55b885945/src-tauri/src/database/dao/providers.rs#L327)。这段路径不能作为密钥加密的证据。本站另行实现 AES-256-GCM，不沿用桌面本地信任边界。

## 在 AI 阅读中的落地

保留官方 AI 和临时 API，新增每账号最多10套个人配置、每套最多20个模型。保存、选择和删除均不调用模型；名称、协议、HTTPS 基础地址、模型列表及默认模型可编辑。密钥只输入、不回显，保存后清空；改变地址或协议必须重新填写密钥。

账号状态和配置分别持久化，API 仅返回元数据。密钥密文绑定账号、配置、版本和全部接口元数据。聊天及任务只记录配置引用；创建轮次固定原配置，切换当前项只影响下一轮。版本检查与聊天占位、批次领取及结果提交共享 SQL 事务，编辑/删除后停止未完成任务并丢弃在途返回。已完成结果继续遵守原24小时期限。

请求适配以各平台的公开协议为依据：[OpenAI 文本与 Responses](https://developers.openai.com/api/docs/guides/text)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)、[版本头](https://platform.claude.com/docs/en/api/versioning)、[Gemini GenerateContent](https://ai.google.dev/api/generate-content)。支持 Chat Completions、Responses、Anthropic Messages、Gemini GenerateContent。只接收完整文本，过滤思考块，拒绝截断、工具调用和不支持的结束状态。自定义接口限公网 IPv4 HTTPS:443，固定解析结果，不跟随重定向，限制时间和响应大小。

没有迁入 CLI/OAuth 凭据、MCP、桌面代理、故障自动切换、测速或自动发现模型。模型 ID 由用户按自己账号权限填写。真实第三方兼容接口的扩展字段和具体模型可用性需要另行联调。

## 验证边界

本地真实 SQL 测试覆盖加密、隔离、并发版本、配置失效、状态不明恢复和迁移升级；HTTPS 测试替换 DNS/网络，四种协议没有真实外发。网页使用实际 Vue 组件和合成 transport 验证，检查1366像素桌面与390像素手机布局及浏览器 Storage 为空。PGlite 单连接验证不代表托管 PostgreSQL 负载测试。

验收命令和上线步骤见 [个人服务商使用与接入](ai-provider-profiles.md)。没有调用真实模型、修改生产环境、推送分支或部署。
