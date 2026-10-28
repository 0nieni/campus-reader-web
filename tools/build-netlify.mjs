import { build as buildWeb } from 'vite'
import { createRequire } from 'node:module'
import { mkdir, readdir, copyFile, lstat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { build: bundle } = createRequire(new URL('../apps/cloud/package.json', import.meta.url))('esbuild')
// Public, already-confirmed project configuration. No credentials are read or bundled here.
process.env.VITE_AI_EXECUTOR = 'netlify'
process.env.VITE_BACKEND = 'netlify'
process.env.VITE_CLOUDBASE_ENV_ID ||= 'cloudbase-d3gw62aemba0c819e'
process.env.VITE_CLOUDBASE_REGION ||= 'ap-shanghai'
process.env.VITE_CLOUDBASE_PASSWORD_READY ||= 'true'
await buildWeb({ root: join(root, 'apps/web') })
const output = join(root, '.netlify-staging', new Date().toISOString().replace(/[^0-9]/g, ''))
await mkdir(dirname(output), { recursive: true }); await mkdir(output)
let assets = 0
async function copyDirectory(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from)) {
    const source = join(from, entry), stat = await lstat(source), destination = join(to, entry)
    if (stat.isSymbolicLink()) throw new Error('发布产物不能包含符号链接')
    if (stat.isDirectory()) await copyDirectory(source, destination)
    else { await copyFile(source, destination); assets++ }
  }
}
await copyDirectory(join(root, 'apps/web/dist'), join(output, 'public'))
await mkdir(join(output, 'functions'))
for (const name of ['api', 'auth', 'guest', 'cleanup', 'identity', 'reminders','reminder-delivery','reminder-tick','reminder-email','material-file','material-schedule','material-collect-background']) {
  const compiled = await bundle({ entryPoints: [join(root, `netlify/functions/${name}.mts`)], outfile: join(output, `functions/${name}.mjs`), bundle: true, external: ['unpdf','word-extractor','xlsx','yauzl'], platform: 'node', format: 'esm', target: 'node22', sourcemap: false, logLevel: 'info', metafile: true, banner: { js: "import { createRequire as __deployCreateRequire } from 'node:module'; const require = __deployCreateRequire(import.meta.url);" } })
  execFileSync(process.execPath,['--check',join(output,`functions/${name}.mjs`)],{stdio:'inherit'})
  if (Object.keys(compiled.metafile.inputs).some(path => /(?:@cloudbase\/(?:node-sdk|database)|node_modules\/(?:axios|lodash\.set|lodash\.unset))\//.test(path.replaceAll('\\', '/')))) throw new Error('全 Netlify 函数不得包含旧 CloudBase SDK 依赖')
}
await copyDirectory(join(root, 'netlify/database/migrations'), join(output, 'netlify/database/migrations'))
await writeFile(join(output, 'package.json'), JSON.stringify({ name: 'campus-reader-netlify-deploy', private: true, type: 'module', dependencies: { '@netlify/database': '2.0.1', '@netlify/identity': '2.0.0', '@netlify/functions': '6.0.2', unpdf:'1.9.1','word-extractor':'1.0.4',xlsx:'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz',yauzl:'3.4.0' } }, null, 2))
await writeFile(join(output, 'verify.mjs'), "import { access } from 'node:fs/promises'; await Promise.all(['public/index.html','functions/api.mjs','functions/auth.mjs','netlify/database/migrations/20261016000100_campus_documents.sql'].map(p=>access(p))); console.log('已核对独立发布产物，不读取本机密钥。');\n")
await writeFile(join(output, 'netlify.toml'), '[build]\n  command = "node verify.mjs"\n  publish = "public"\n  functions = "functions"\n[build.environment]\n  NODE_VERSION = "22"\n[functions]\n  node_bundler = "esbuild"\n[functions.cleanup]\n  schedule = "17 18 * * *"\n[functions.reminders]\n  schedule = "0 1,12 * * *"\n[functions.api]\n  external_node_modules = ["unpdf","word-extractor","xlsx","yauzl"]\n[functions.material-file]\n  external_node_modules = ["unpdf","word-extractor","xlsx","yauzl"]\n[functions.material-collect-background]\n  external_node_modules = ["unpdf","word-extractor","xlsx","yauzl"]\n[functions.material-schedule]\n  schedule = "45 18 * * *"\n[[headers]]\n  for = "/*"\n  [headers.values]\n    X-Content-Type-Options = "nosniff"\n    Referrer-Policy = "strict-origin-when-cross-origin"\n')
await writeFile(join(output, '.gitignore'), '.netlify/\n.env\n.env.*\n')
const { default: handler } = await import(pathToFileURL(join(output, 'functions/api.mjs')).href)
const denied = await handler(new Request('https://localhost/.netlify/functions/api', { method: 'POST', headers: { origin: 'https://localhost','content-type':'application/json' }, body:JSON.stringify({action:'ai.status',input:{}}) }))
if (denied.status !== 401 || denied.headers.get('cache-control') !== 'no-store') throw new Error('部署函数的未登录拒绝检查失败')
const health=await handler(new Request('https://localhost/.netlify/functions/api?health=collection'))
const healthBody=await health.json()
if(health.status!==200||health.headers.get('cache-control')!=='no-store'||healthBody.check!=='configuration_only'||typeof healthBody.configured!=='boolean'||!Array.isArray(healthBody.issues)||Object.keys(healthBody).some(key=>!['check','configured','issues','processEnvironment'].includes(key)))throw new Error('采集配置脱敏诊断检查失败')
const stillDenied=await handler(new Request('https://localhost/.netlify/functions/api?health=collection',{method:'POST',headers:{origin:'https://localhost','content-type':'application/json'},body:JSON.stringify({action:'ai.status',input:{}})}))
if(stillDenied.status!==401)throw new Error('诊断查询不得绕过业务API认证')
console.log(`Netlify 部署产物：${output}`)
console.log(`仅包含网页、12 个 Netlify 函数与 SQL 迁移；不含本地环境文件，未上传、未调用模型。`)
