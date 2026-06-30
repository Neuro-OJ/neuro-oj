#!/usr/bin/env node
// postinstall hook：把 monaco-editor/min/vs 自托管到 public/monaco，
// 并扫描 editor.main.js 提取真实带 hash 的 worker 文件名，写入
// public/monaco/workers.json 给前端运行时读取。
// 解决国内网络下 unpkg.com 不可达问题（issue #82）。
import { cp, rm, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const src = join(root, "node_modules/monaco-editor/min/vs")
const dst = join(root, "public/monaco")
const manifestPath = join(dst, "workers.json")

if (!existsSync(src)) {
  console.warn("[copy-monaco] node_modules/monaco-editor/min/vs 不存在，跳过")
  process.exit(0)
}

await rm(dst, { recursive: true, force: true })
await mkdir(dst, { recursive: true })
await cp(src, dst, { recursive: true })
console.log(`[copy-monaco] 已复制 ${src} -> ${dst}`)

// 扫描真实 worker 文件名（monaco 0.55+ worker 路径带 hash，参见 editor.main.js）
const assetsDir = join(dst, "assets")
let editorWorker = null
let tsWorker = null
let jsonWorker = null
let cssWorker = null
let htmlWorker = null
try {
  const files = await readdir(assetsDir)
  for (const f of files) {
    if (f.startsWith("editor.worker-") && f.endsWith(".js")) editorWorker = `assets/${f}`
    else if (f.startsWith("ts.worker-") && f.endsWith(".js")) tsWorker = `assets/${f}`
    else if (f.startsWith("json.worker-") && f.endsWith(".js")) jsonWorker = `assets/${f}`
    else if (f.startsWith("css.worker-") && f.endsWith(".js")) cssWorker = `assets/${f}`
    else if (f.startsWith("html.worker-") && f.endsWith(".js")) htmlWorker = `assets/${f}`
  }
} catch (err) {
  console.warn("[copy-monaco] 扫描 assets/ 失败:", err.message)
}

const manifest = {
  version: "0.55.1",
  editor: editorWorker,
  workers: {
    typescript: tsWorker,
    javascript: tsWorker, // monaco 把 JS 复用 TS worker
    json: jsonWorker,
    css: cssWorker,
    html: htmlWorker,
    // python / 其他基础语言：使用通用 editor worker 即可
  },
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
console.log(`[copy-monaco] worker manifest 写入 ${manifestPath}`)
console.log(`[copy-monaco] editor worker: ${editorWorker}`)
