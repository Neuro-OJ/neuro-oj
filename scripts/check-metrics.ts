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
// 接收者可选：
// - noj-core 通过 registry 对象写入（`observabilityRegistry.inc("noj_...")`）；
// - noj-llm-gateway 直接调用模块函数（`inc("noj_...")`，无接收者）。
// 此前的模式强制要求前导 `.`，导致网关的全部写入点都匹配不到（门禁对它形同虚设）。
// 因模式后半段强制 `"noj_` 字面量，放宽接收者不会引入误报。
const WRITE_RE = /(?:\.|\b)(?:inc|set|add|observe)\(\s*"(noj_[a-z0-9_]+)"/g;

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

  // ── noj-core：指标名来自 registerBusinessMetric + 平台指标常量 ──
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

  // ── noj-llm-gateway（评审补充）──
  //
  // 此前只扫 noj-core/src，网关的指标写入完全不受门禁约束。而网关的
  // `inc()/observe()` 对未定义指标是**静默 no-op**（metrics.ts 的
  // `if (!META[name]) return;`），因此一个拼错的指标名会永久丢失该序列，
  // 且 /metrics 上看不出任何异常——SLO 与看板静默失真。
  // 这里用网关自己的指标定义（METRICS 常量表）作为已知集合来校验其调用点。
  const gatewayDir = resolve(root, "noj-llm-gateway/src");
  let gatewayFiles: string[] = [];
  try {
    gatewayFiles = await collectTsFiles(gatewayDir);
  } catch {
    // 网关目录不存在（例如独立部署裁剪）→ 跳过，不误报
    gatewayFiles = [];
  }
  if (gatewayFiles.length > 0) {
    // 已知集合只取**指标定义表** META 里的键（`name: { help: ..., type: ... }`），
    // 不能用「网关源码里出现过的任何 noj_* 字面量」——那会把拼错的调用点也当作
    // 定义，形成恒真断言（实测：把调用点改成 noj_typo_metric_xyz 仍判通过）。
    const META_DEF_RE = /^\s*(noj_[a-z0-9_]+):\s*\{\s*help:/gm;
    const gatewayKnown = new Set<string>();
    for (const file of gatewayFiles) {
      const content = await Deno.readTextFile(file);
      for (const m of content.matchAll(META_DEF_RE)) {
        if (m[1]) gatewayKnown.add(m[1]);
      }
    }
    if (gatewayKnown.size === 0) {
      errors.push(
        "未能在 noj-llm-gateway/src 中找到任何指标定义（META 表），" +
          "网关指标检查已失去意义",
      );
    } else {
      for (const file of gatewayFiles) {
        if (file.includes("/tests/")) continue;
        // 指标定义文件自身不参与「调用点」检查（它的字面量就是定义）
        if (file.endsWith("/metrics.ts")) continue;
        const content = await Deno.readTextFile(file);
        for (const error of checkMetricCalls(content, gatewayKnown)) {
          errors.push(`${file}: ${error}`);
        }
      }
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
