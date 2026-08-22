#!/usr/bin/env node
// 构建期补丁：Monaco Editor 内置 workerManager 使用 `new Worker(new URL(...))`
// 触发 Vite/Rolldown 的 worker 打包插件，在 Deno 构建环境下报
// "Failed to unwrap exclusive reference of BindingCallableBuiltinPlugin"。
//
// 本项目已通过 `public/monaco/workers.json` + `MonacoEnvironment.getWorker`
// 自托管 worker，因此不需要 Vite 重新打包这些 worker。这里把内置 workerManager
// 的默认 worker 创建逻辑替换为 `MonacoEnvironment.getWorker`。
//
// 仅修改 node_modules 内的构建产物，不提交 node_modules。

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const FEATURES = ["html", "css", "json", "typescript"];

const replacement = `createWorker: () => {
          const worker = self.MonacoEnvironment?.getWorker('worker', this._modeId);
          if (!worker) throw new Error('No Monaco worker available for ' + this._modeId);
          return worker;
        }`;

for (const feature of FEATURES) {
  const file = join(
    root,
    "node_modules/monaco-editor/esm/vs/languages/features",
    feature,
    "workerManager.js",
  );

  let source;
  try {
    source = await readFile(file, "utf8");
  } catch {
    console.warn(`[patch-monaco] 跳过 ${feature}: 文件不存在`);
    continue;
  }

  const pattern = /createWorker:\s*\(\)\s*=>\s*new Worker\(new URL\(['"][^'"]+['"],\s*import\.meta\.url\),\s*\{\s*type:\s*["']module["']\s*\}\)/;
  if (!pattern.test(source)) {
    console.warn(`[patch-monaco] 跳过 ${feature}: 未找到可替换的 worker 创建表达式`);
    continue;
  }

  source = source.replace(pattern, replacement);
  await writeFile(file, source);
  console.log(`[patch-monaco] 已修补 ${feature}/workerManager.js`);
}
