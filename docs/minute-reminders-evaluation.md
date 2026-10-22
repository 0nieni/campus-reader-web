# 关闭网页后的分钟提醒评估

路线更新（2026-10-21）：用户已用 [阿里云计划](aliyun-reminders-plan-2026-10-21.md) 替代本文件后续 QStash 路线。新实现使用 FC 签名分钟触发、Netlify Blobs 唤醒索引及 DirectMail/标准 Web Push；账号和域名未准备，本次先交付代码与预览。见 [阿里云配置指南](aliyun-reminders-setup.md)。以下费用与状态属于历史记录。

核对日期：2026-10-21。用户已选择QStash免费延时队列，要求覆盖Windows、iPhone／iPad和安卓。代码已接入，服务账号配置、正式发布和三端真实送达验收待完成；未调整付费计划。配置见 [开启分钟提醒](qstash-setup.md)。以下保留方案权衡与验收依据。

## 结论

可以在保存时间时登记后台任务，到预定时刻发起标准 Web Push，用户无须保持网页打开。目标是接近设定分钟发起发送；网络、设备离线、浏览器进程退出和系统通知策略可能造成延迟，不能承诺手机像本地闹钟一样严格准点。[Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)、[后台推送流程](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation)

改造前已有推送订阅、加密签名、Worker和站内收件箱，但只在北京时间09:00、20:00扫描。现已新增事务outbox、QStash延时登记和验签回调；预览环境禁用真实队列和推送，不能据此认定已通过关页送达验收。

## 方案一：沿用 Netlify 的 Async Workloads

安装 Netlify Async Workloads 扩展，设置时间时发送带 `delayUntil` 的事件。平台支持未来任务，最长一年；当前产品允许两年内时间，需要缩短范围，或先保留远期事项、临近时登记任务。平台默认每60秒调度一次，允许调整到最低10秒；因此它是分钟级调度，不是精确秒级计时器。[事件时间](https://docs.netlify.com/build/async-workloads/sending-events/)、[调度配置](https://docs.netlify.com/build/async-workloads/optional-configuration/)

优势是沿用现有平台，用户不必新增第三方账号。任务状态存于 Netlify Blobs，可以避免每分钟扫描业务 SQL。扩展创建的函数和存储依照普通资源计费，启用前要测量空闲调度和单次推送成本，再确认能否放入网站现有免费预算；不能把“支持免费套餐”理解为运行没有额度开销。[资源与计费](https://docs.netlify.com/build/async-workloads/overview/)、[任务状态存储](https://docs.netlify.com/build/async-workloads/lifecycle/)

## 方案二：QStash 延时队列

由 QStash 保存预定发送时间，到时调用本站的验签回调。仅回调时唤醒 SQL，查验事项仍有效后发送推送。免费档当前为每天1000次消息投递，重试也计数，单个延时最长7天。长于7天的事项可保留在本站，在每日维护中滚动登记未来6天的任务；保存新时间和新设备订阅时也补登记，避免漏掉当天事项。[免费额度](https://upstash.com/pricing/qstash)、[指定时间投递](https://upstash.com/docs/qstash/features/delay)

这是本项目小规模使用时优先考虑的方案：调度空闲期不必持续占用本站函数。代价是需要新增 Upstash 账号及服务端凭据。免费额度不是无限容量，Netlify 的回调函数和数据库仍消耗原平台额度，提醒密集时需要重新评估。第三方任务仅带不可猜的任务编号，公告正文、标题、推送端点和账号凭据保留在本站；回调验证签名、原始请求体和目标URL。[回调验签](https://upstash.com/docs/qstash/howto/signature)

## 不采用每分钟直接扫描现有 SQL

数据库默认空闲5分钟后休眠，每分钟查一次将使其持续运行。按30天连续活跃估算约720小时，远超公开 Free 计划的48数据库计算单位上限；这里只是容量估算，未读取本人实际账单。函数、带宽、网页和生产部署也共用账户额度。[休眠机制](https://docs.netlify.com/build/data-and-storage/netlify-database/configure-sleep-on-inactivity/)、[数据库额度](https://docs.netlify.com/build/data-and-storage/netlify-database/billing-and-usage/)

Cloudflare 每分钟任务若仍调用本站扫描相同 SQL，也不能解决上述问题；增加调度平台本身不能减少数据库唤醒。自行设计 Blobs 时间索引可避免 SQL 轮询，但需承担跨存储一致性、并发写和补偿机制，不优先于现成延时队列。

## 实施与验收边界

选择方案后，实施内容包括：

1. 按本人、事项版本、提前档位登记任务；数据库使用事务与 outbox 保证保存和登记失败可恢复。改期、取消、移除设备后，旧任务必须失效。
2. 到点仅处理指定事项，重验原公告权限和当前设备归属；不能沿用现有每次20账号轮换扫描来声称所有账号同一分钟发送。
3. 站内消息与系统通知分别记账。提前打开站内消息、自动刷新或并发检查不能误吞尚未发送的系统提醒；重复回调不得重复发送。网络结果不明时记录“状态未知”，避免承诺绝不重复或自动无限重试。
4. 界面区分“待设置”“已保存但未登记成功”“已登记待发送”“推送服务已接收”“失败／状态未知”；接收请求不等于设备已弹出。
5. 完成本地合成回归，再在受控环境中由用户授权开启推送，设置几分钟后的事项、关闭页面，记录预定时间、服务端发送时间及设备显示时间。测试取消／改期、重复回调、离线恢复、多设备与退出账号。现有预览不启用真实用户推送。

iPhone／iPad需从添加到主屏幕的网页应用主动授权；Windows和安卓同样需要支持的浏览器和系统通知权限。用户已确认三端都要，实际送达仍需逐端测试。[Apple说明](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

本轮实现调度代码及本地验证，不宣称未配置、未正式发布的服务已经生效，也不以模拟设备测试替代真实手机推送链路。
