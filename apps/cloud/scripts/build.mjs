import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const [name, entry] of [["webGateway", "index.ts"], ["webAi", "worker.ts"]]) {
const out = resolve(root, `functions/${name}`);
await mkdir(out, { recursive: true });
await build({
  entryPoints: [resolve(root, `src/${entry}`)],
  outfile: resolve(out, "index.js"),
  bundle: true,
  platform: "node",
  target: "node16.13",
  format: "cjs",
  external: ["@cloudbase/node-sdk"],
  sourcemap: false,
  logLevel: "info",
});
await writeFile(
  resolve(out, "package.json"),
  JSON.stringify(
    {
      name: "campus-web-gateway",
      version: "0.1.0",
      private: true,
      main: "index.js",
      engines: { node: ">=16.13" },
      dependencies: { "@cloudbase/node-sdk": "3.18.3" },
    },
    null,
    2,
  ) + "\n",
);
execFileSync(process.execPath, ["--check", resolve(out, "index.js")], {
  stdio: "inherit",
});
console.log(`${name} 已按 Node 16.13 打包并通过语法检查；部署与配置以实际云端记录为准。`);
}
