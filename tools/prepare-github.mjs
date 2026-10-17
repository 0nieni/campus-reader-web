import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The workspace also contains unrelated research. Publish only reviewed app sources.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, '.github-staging', new Date().toISOString().replace(/[^0-9]/g, ''))
const allowed = ['package.json', 'package-lock.json', 'netlify.toml', 'apps/web', 'apps/cloud', 'packages/contracts', 'netlify/functions', 'netlify/database/migrations', 'tools/build-netlify.mjs', 'tools/prepare-github.mjs']
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

个人使用的校园公告、收藏与 AI 阅读网站。Vue 3 + TypeScript + Netlify Functions、Identity 和 Database。代码仓库保持私有，网站按本人邮箱白名单访问。

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

将此私有仓库连接到现有 Netlify 项目，保留根目录 netlify.toml；构建命令为 npm run build --workspace=@campus/web，发布目录为 apps/web/dist，函数目录为 netlify/functions。两份 SQL 迁移位于 netlify/database/migrations，由平台在部署生命周期应用，不在网页或函数请求中执行建表。

服务端环境变量：NETLIFY_OWNER_EMAIL（本人邮箱）、AI_CHAT_API_KEY（DeepSeek Key）；可选 AI_CHAT_BASE_URL、AI_CHAT_MODEL、AI_DAILY_LIMIT、AI_PLATFORM_DAILY_CALLS、AI_PLATFORM_DAILY_TOKENS。全部通过 Netlify 环境变量配置，不能加入 VITE_ 变量或提交到 Git。

Identity 需要启用并设为 Invite only。先验证预览分支迁移和真实数据，再发布主站；仓库上传成功不等于网站或数据库已上线。当前手工 CLI 预览缺少迁移构建步骤，Git 云端构建是否解决仍需实际验证。

AI 默认每日 5 次、北京时间零点重置。任务正文满 24 小时拒读、访问时清理，每天北京时间 02:17 定时兜底清理，无人访问时不保证第 24 小时准点物理删除。

两份迁移包含新站表结构与 5 个公开来源、27 条公告的有限导入，不含私人邮件、旧 AI 任务或账号密码。原 CloudBase 适配代码保留作兼容参考，Netlify 业务入口使用独立 SQL 存储；自动采集、邮件、提醒等后台尚未迁移。

DeepSeek API 单独计费；Netlify Free 的计算、流量和部署使用共享额度，不承诺无限免费。
`, { flag: 'wx' })
console.log(`GitHub 发布源：${output}`)
console.log(`已核对 ${files.length + 2} 个文件，包括 4 个函数源文件；排除环境文件、生成产物和无关资料。尚未提交或上传。`)
