/**
 * 指标 catalog 静态检查。
 *
 * 扫描 noj-core/src 下 registerBusinessMetric 定义与 observability 写入调用，
 * 任何未进 catalog 的指标名直接报错。
 */

import { resolve } from "node:path";
import { PLATFORM_METRIC_NAMES } from "../noj-core/src/domains/observability/metrics/platform.ts";

const DEFINE_RE = /registerBusinessMetric\(\s*\{[\s\S]*?name:\s*"([^"]+)"/g;
// 锚定指标名前缀而非接收者变量名：接收者可能是 observability / metrics /
// registry / observabilityRegistry 或任意别名，列不全就会漏检（曾因此只覆盖
// 生产代码 1 个写入点）。`noj_` 前缀由 validateMetricDefinition 强制，
// 且定义处写作 `name: "..."`，不会与本模式冲突。
const WRITE_RE = /\.(?:inc|set|add|observe)\(\s*"(noj_[a-z0-9_]+)"/g;

export function checkMetricCalls(
  content: string,
  known: Set<string>,
): string[] {
  const errors: string[] = [];
  for (const m of content.matchAll(WRITE_RE)) {
    if (m[1] && !known.has(m[1])) errors.push(`未定义指标: ${m[1]}`);
  }
  return errors;
}

async function collectTsFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(current: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const full = `${current}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(full);
      } else if (entry.isFile && entry.name.endsWith(".ts")) {
        results.push(full);
      }
    }
  }
  await walk(dir);
  return results;
}

export async function checkMetrics(root = "."): Promise<string[]> {
  const known = new Set<string>(PLATFORM_METRIC_NAMES);
  const errors: string[] = [];
  const srcDir = resolve(root, "noj-core/src");
  const files = await collectTsFiles(srcDir);
  for (const file of files) {
    const content = await Deno.readTextFile(file);
    for (const m of content.matchAll(DEFINE_RE)) {
      if (m[1]) known.add(m[1]);
    }
  }
  for (const file of files) {
    const content = await Deno.readTextFile(file);
    for (const error of checkMetricCalls(content, known)) {
      errors.push(`${file}: ${error}`);
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = await checkMetrics(".");
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    Deno.exit(1);
  }
  console.log("指标 catalog 检查通过");
}
