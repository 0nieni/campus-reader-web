# 开启分钟级系统提醒

实现已接入PR，正式站点启用需要以下配置和发布。本指南不包含密钥，配置时不要将密钥粘贴到聊天、源码或截图中。

## 1. 创建免费QStash账号

打开 [Upstash控制台](https://console.upstash.com/qstash)，登录或注册，选择QStash免费档。无需升级付费套餐。本项目不自动升级、不创建收费订阅。

在QStash控制台找到Token、Current Signing Key、Next Signing Key，以及该实例显示的API URL。地区不同，API URL可能不同，请使用控制台提供的地址，不自行拼接。

## 2. 配置到现有Netlify项目

打开 [校园阅览室Netlify项目](https://app.netlify.com/projects/campus-reader-ninie6159)，进入项目配置的环境变量页面，添加：

- `QSTASH_TOKEN`：QStash Token。
- `QSTASH_CURRENT_SIGNING_KEY`：Current Signing Key。
- `QSTASH_NEXT_SIGNING_KEY`：Next Signing Key。
- `QSTASH_URL`：控制台显示的API基础地址，例如 `https://qstash.upstash.io`，不要附带 `/v2/publish` 等路径。

前三个标记为Secret。四个变量均仅用于 **Production** 环境及 **Functions** scope，不放入Deploy Previews，不使用 `VITE_` 前缀。已有 `WEB_PUSH_PUBLIC_KEY`／`WEB_PUSH_PRIVATE_KEY` 无须重新生成。

环境变量修改后需要重新部署才会生效。当前PR仍须按双方互审约定审核后正式发布；不要把回调指向预览站点。

正式回调固定为：`https://campus-reader-ninie6159.netlify.app/.netlify/functions/reminder-delivery`。无需在QStash手动创建每分钟Cron；网站保存事项时会自动登记延时消息。

## 3. 分别开启三类设备

每台设备独立登录同一个网站账号，并在提醒中心点击“开启此浏览器推送”，再发测试通知。

- Windows：Chrome或Edge，允许网站及系统通知；建议安装为应用，保留浏览器后台运行。完全退出浏览器或系统休眠时不能保证准时显示。
- iPhone／iPad：Safari中“添加到主屏幕”，从主屏幕图标进入后允许通知。[Apple说明](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- 安卓：使用支持Web Push的浏览器，允许系统通知和后台活动；机型、省电设置和推送网络通达性需要实际测试。不支持的浏览器会显示说明，不伪装成已开启。

每个账号最多5个浏览器。退出账号会解绑当前浏览器，其他设备不受影响。推送仅显示“你有新的提醒，请登录提醒中心查看”，学校及公告内容在登录后查看。

## 4. 关页验收

在正式环境设置几分钟后的提醒，确认该事项显示“已登记后台提醒”。关闭页面，分别记录预定时间、服务端接收结果和设备弹出时间。三端均应独立测试，不以浏览器模拟手机的结果代替真机。

再验证修改时间、移出提醒、退出账号、离线恢复与重复回调；旧任务不应继续发出新推送。看到“推送服务已接收”只代表厂商接收，不能等同设备已显示。

## 免费额度边界

QStash免费档当前每天1000次投递，失败重试也计数；最长延时7天。网站使用未来6天滚动登记，远期事项保留在数据库，临近时登记。每日09:00／20:00只进行登记补偿，不再承担到点全账号扫描推送。

本应用按计划投递日期限制最多400次发布预约、每条最多1次回调重试。取消和不确定的发布仍保留预约计数；该保护不覆盖账号中其他应用、跨日重试或第三方调整的计费规则，应查看控制台用量。达到保护限额时界面会显示登记尚未成功，不会声称提醒已生效，也不会自动购买额度。

Netlify函数、数据库和网页仍共用原平台额度。网站不会为了分钟提醒而每分钟轮询SQL。实际容量和设备送达需上线后按用量与实测评估。

参考：[QStash额度](https://upstash.com/pricing/qstash)、[延时任务](https://upstash.com/docs/qstash/features/delay)、[Netlify环境变量](https://docs.netlify.com/build/environment-variables/overview/)
