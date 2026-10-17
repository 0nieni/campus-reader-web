import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The workspace also contains unrelated research. Publish only reviewed app sources.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, '.github-staging', new Date().toISOString().replace(/[^0-9]/g, ''))
const allowed = ['package.json', 'package-lock.json', 'netlify.toml', 'apps/web', 'apps/cloud', 'packages/contracts', 'netlify/functions', 'netlify/database/migrations', 'tools/build-netlify.mjs', 'tools/prepare-github.mjs', 'tools/extract-school-directory.py']
const excludedDirectories = new Set(['node_modules', 'dist', '.git', '.netlify', 'coverage', 'test-results', 'playwright-report', 'functions'])
const files = []
async function collect(path) {
  const source = join(root, path)
  const stat = await lstat(source)
  if (stat.isSymbolicLink()) throw new Error(`发布源不允许符号链接：${path}`)
  if (stat.isDirectory()) {
    for (const name of await readdir(source)) {
      if (excludedDirectories.has(name) || name.endsWith('.local') || name.endsWith('.log') || (name.startsWith('.env') && name !== '.env.example')) continue
      await collect(join(path, name))
    }
  } else if (stat.isFile()) {
    const content = await readFile(source)
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{20,})\b/.test(content.toString('utf8'))) throw new Error(`发布源疑似包含凭据，已停止：${path}`)
    files.push({ path, content })
  }
}
for (const path of allowed) await collect(path)
if (files.filter(({ path }) => path.replaceAll('\\', '/').startsWith('netlify/functions/')).length !== 4) throw new Error('发布清单必须包含四个 Netlify 函数源文件')
await mkdir(dirname(output), { recursive: true })
await mkdir(output)
for (const { path, content } of files) {
  const destination = resolve(output, path)
  if (relative(output, destination).startsWith('..')) throw new Error('发布路径超出暂存目录')
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, content, { flag: 'wx' })
}
await writeFile(join(output, '.gitignore'), 'node_modules/\ndist/\n/apps/cloud/functions/\n.env\n.env.*\n!.env.example\n*.local\n.netlify/\n.netlify-staging/\n.github-staging/\n.github-tools/\ncoverage/\ntest-results/\nplaywright-report/\n*.log\n', { flag: 'wx' })
await writeFile(join(output, 'README.md'), `# 校园阅览室

面向受邀用户的校园公告、收藏与 AI 阅读网站。Vue 3 + TypeScript + Netlify Functions、Identity 和 Database。代码仓库保持私有，每个 Identity 账号使用独立的工作区。

## 本地检查

需要 Node.js >=22.12。

\`\`\`sh
npm ci
npm run typecheck
npm test
npm run build --workspace=@campus/web
\`\`\`

本地 SQL 测试使用单进程 Postgres 兼容引擎，不代表远端负载验证；模型测试使用测试桩。Netlify 登录须在真实部署中验证。

## Netlify 构建

将此私有仓库连接到现有 Netlify 项目，保留根目录 netlify.toml。Base directory 和 Package directory 均留空：这是包含网页、服务端函数和迁移的一个完整站点，不单独选择 apps/web 作为站点项目目录。构建命令为 npm run build --workspace=@campus/web，发布目录为 apps/web/dist，函数目录为 netlify/functions。SQL 迁移位于 netlify/database/migrations，由平台在部署生命周期应用，不在网页或函数请求中执行建表。

服务端环境变量：NETLIFY_OWNER_EMAIL（保留初始账号数据的邮箱，不是成员白名单）、AI_CHAT_API_KEY（DeepSeek Key）；可选 AI_CHAT_BASE_URL、AI_CHAT_MODEL、AI_DAILY_LIMIT、AI_PLATFORM_DAILY_CALLS、AI_PLATFORM_DAILY_TOKENS。全部通过 Netlify 环境变量配置，不能加入 VITE_ 变量或提交到 Git。

Identity 需要启用并保持 Invite only，由管理员在控制台邀请成员。正式站点需允许访问登录页，预览可继续私有。每个成员按可信 Identity UID 隔离学校偏好、收藏、私人资料、AI 任务及每天五次额度；原始账号继续使用现有数据。DeepSeek 账单和平台总调用预算由站点共同承担。不要为新增成员修改 NETLIFY_OWNER_EMAIL，否则会改变原工作区归属。

AI 默认每日 5 次、北京时间零点重置。任务正文满 24 小时拒读、访问时清理，每天北京时间 02:17 定时兜底清理，无人访问时不保证第 24 小时准点物理删除。

迁移包含新站表结构、原 5 个公开来源/27 条公告，以及用户提供的 115 所高校目录，不含私人邮件、旧 AI 任务或账号密码。登录后可搜索选校，选校和刷新时按需读取该校公开公告、缓存一小时；正文按需读取，不自动遍历所有学校。校园网、登录入口或页面结构未适配时明确提示，保留原站链接和已有公告，不绕过访问限制。原 CloudBase 适配代码保留作兼容参考，Netlify 业务入口使用独立 SQL 存储。

学校添加申请：在 Netlify Forms 开启 Form detection，部署后应识别 school-add-request。再在 Forms > Submission notifications 添加该表单的 Email notification，接收邮箱 ninie6159@gmail.com。服务端从可信会话取邮箱、校验校名，每账号每天最多 3 所，同日同名防重发，通知状态未知不自动重投。正式站点才转发表单通知；本地/预览不发送。查看 Spam 栏核对误判，不关闭反垃圾。公告抓取和申请功能分别消耗正常函数/数据库/表单资源，不产生模型调用。

DeepSeek API 单独计费；Netlify Free 的计算、流量和部署使用共享额度，不承诺无限免费。
`, { flag: 'wx' })
console.log(`GitHub 发布源：${output}`)
console.log(`已核对 ${files.length + 2} 个文件，包括 4 个函数源文件；排除环境文件、生成产物和无关资料。尚未提交或上传。`)
