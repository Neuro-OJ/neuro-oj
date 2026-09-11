/**
 * Grafana 看板表达式检查。
 *
 * 背景（2026-09-11 评审）：看板里出现过 `noj_llm_request_duration_seconds` 这样的
 * **裸直方图家族名**。直方图在 /metrics 里展开为 `_bucket` / `_sum` / `_count`
 * 三条序列，家族名本身**不产生任何序列**，因此该 panel 永远为空——但看板不会报错，
 * 静默显示空白，没人会发现 SLO 视图其实是坏的。
 *
 * 本脚本校验 deploy/monitoring/grafana-dashboard.json 中的每个 PromQL 表达式：
 * 1. 引用的指标名必须在某处有定义（noj-core 平台指标 / 业务指标 / 网关指标 / 标准导出器）；
 * 2. 直方图指标**不得裸用**——必须经 `histogram_quantile(... _bucket ...)`、
 *    `_sum` / `_count` 或显式 `rate(..._bucket[...])` 使用。
 */

import { resolve } from "node:path";

/** 标准导出器/依赖方指标前缀：不由本仓库定义，允许直接引用。 */
const EXTERNAL_PREFIXES = [
  "node_",
  "process_",
  "promhttp_",
  "go_",
  "up",
  "scrape_",
  "redis_",
  "pg_",
  "postgres",
  "container_",
];

/** 从 PromQL 表达式里提取候选指标名（保守：只取明显的标识符 token）。 */
export function extractMetricNames(expr: string): string[] {
  // 去掉 label matcher 内部（{...}）与字符串字面量，避免把标签值当指标名
  const cleaned = expr
    .replace(/\{[^}]*\}/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/'[^']*'/g, " ");
  const names = new Set<string>();
  for (
    const m of cleaned.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\{|\[|\b)/g)
  ) {
    const name = m[1]!;
    // PromQL 函数名与关键字不是指标
    if (PROMQL_KEYWORDS.has(name)) continue;
    names.add(name);
  }
  return [...names];
}

/** PromQL 内建函数/关键字（非指标名）。 */
const PROMQL_KEYWORDS = new Set([
  "histogram_quantile",
  "rate",
  "irate",
  "increase",
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "by",
  "without",
  "le",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "offset",
  "bool",
  "abs",
  "ceil",
  "floor",
  "round",
  "clamp_max",
  "clamp_min",
  "delta",
  "deriv",
  "idelta",
  "predict_linear",
  "absent",
  "absent_over_time",
  "vector",
  "scalar",
  "time",
  "timestamp",
  "topk",
  "bottomk",
  "quantile",
  "stddev",
  "stdvar",
  "count_values",
  "changes",
  "resets",
  "avg_over_time",
  "max_over_time",
  "min_over_time",
  "sum_over_time",
  "count_over_time",
  "last_over_time",
  "present_over_time",
  "and",
  "or",
  "unless",
  "label_replace",
  "label_join",
  "sort",
  "sort_desc",
  "sort_by_label",
  "day_of_week",
  "hour",
  "minute",
  "month",
  "year",
  "exp",
  "ln",
  "log2",
  "log10",
  "sqrt",
  "sgn",
  "deg",
  "rad",
  "pi",
  "atan2",
  "group",
]);

/** 判断指标名是否属于标准导出器（无需本仓库定义）。 */
export function isExternalMetric(name: string): boolean {
  return EXTERNAL_PREFIXES.some((p) =>
    name === p || name.startsWith(`${p}_`) || name.startsWith(p)
  );
}

/** 收集仓库内定义的全部指标名（含直方图标记）。 */
export async function collectDefinedMetrics(
  root: string,
): Promise<Map<string, "counter" | "gauge" | "histogram" | "unknown">> {
  const defined = new Map<
    string,
    "counter" | "gauge" | "histogram" | "unknown"
  >();

  // noj-core：平台指标常量 + 业务指标（registerBusinessMetric）
  const srcDir = resolve(root, "noj-core/src");
  const coreFiles: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory) {
        if (["node_modules", ".deno_cache", ".test-cache"].includes(e.name)) {
          continue;
        }
        await walk(full);
      } else if (e.isFile && e.name.endsWith(".ts")) {
        coreFiles.push(full);
      }
    }
  }
  await walk(srcDir);

  for (const file of coreFiles) {
    const content = await Deno.readTextFile(file).catch(() => "");
    // registerBusinessMetric / define 的定义块：name 与 type 都在同一个对象里
    for (
      const m of content.matchAll(
        /name:\s*"(noj_[a-z0-9_]+)"[\s\S]{0,300}?type:\s*"(counter|gauge|histogram)"/g,
      )
    ) {
      if (m[1] && m[2]) {
        defined.set(m[1], m[2] as "counter" | "gauge" | "histogram");
      }
    }
    // 兜底：只出现名字（可能定义在别处或以常量形式）
    for (const m of content.matchAll(/"(noj_[a-z0-9_]+)"/g)) {
      if (m[1] && !defined.has(m[1])) defined.set(m[1], "unknown");
    }
  }

  // noj-llm-gateway：META 表
  const gatewaySrc = await Deno.readTextFile(
    resolve(root, "noj-llm-gateway/src/metrics.ts"),
  ).catch(() => "");
  for (
    const m of gatewaySrc.matchAll(
      /^\s*(noj_[a-z0-9_]+):\s*\{\s*help:[\s\S]{0,200}?type:\s*"(counter|histogram)"/gm,
    )
  ) {
    if (m[1] && m[2]) defined.set(m[1], m[2] as "counter" | "histogram");
  }

  return defined;
}

export interface DashboardProblem {
  panel: string;
  expr: string;
  problem: string;
}

/** 校验单个表达式。 */
export function checkExpression(
  panelTitle: string,
  expr: string,
  defined: Map<string, "counter" | "gauge" | "histogram" | "unknown">,
): DashboardProblem[] {
  const problems: DashboardProblem[] = [];
  for (const name of extractMetricNames(expr)) {
    if (isExternalMetric(name)) continue;

    // 直方图的派生序列：_bucket / _sum / _count 都可直接用
    const base = name.replace(/_(bucket|sum|count)$/, "");
    const type = defined.get(name) ?? defined.get(base);

    if (!type) {
      problems.push({
        panel: panelTitle,
        expr,
        problem: `引用了未定义的指标: ${name}`,
      });
      continue;
    }

    // 直方图裸用：既不是派生序列，也没有在 histogram_quantile 里用 _bucket
    if (type === "histogram" && name === base) {
      const usedCorrectly = expr.includes(`${base}_bucket`) ||
        expr.includes(`${base}_sum`) || expr.includes(`${base}_count`);
      if (!usedCorrectly) {
        problems.push({
          panel: panelTitle,
          expr,
          problem:
            `裸用直方图家族名 ${name}：家族名本身不产生序列，该 panel 会永远为空。` +
            `请改用 histogram_quantile(... ${name}_bucket ...) 或 ${name}_sum/_count`,
        });
      }
    }
  }
  return problems;
}

/** 检查看板文件。 */
export async function checkDashboards(root = "."): Promise<DashboardProblem[]> {
  const dashboardPath = resolve(
    root,
    "deploy/monitoring/grafana-dashboard.json",
  );
  let raw: string;
  try {
    raw = await Deno.readTextFile(dashboardPath);
  } catch {
    return [{
      panel: "-",
      expr: "-",
      problem: `看板文件不存在: ${dashboardPath}`,
    }];
  }

  let dashboard: {
    panels?: Array<{ title?: string; targets?: Array<{ expr?: string }> }>;
  };
  try {
    dashboard = JSON.parse(raw);
  } catch (err) {
    return [{
      panel: "-",
      expr: "-",
      problem: `看板 JSON 解析失败: ${
        err instanceof Error ? err.message : err
      }`,
    }];
  }

  const defined = await collectDefinedMetrics(root);
  const problems: DashboardProblem[] = [];
  let targetCount = 0;
  for (const panel of dashboard.panels ?? []) {
    for (const target of panel.targets ?? []) {
      if (!target.expr) continue;
      targetCount += 1;
      problems.push(
        ...checkExpression(panel.title ?? "(无标题)", target.expr, defined),
      );
    }
  }

  // 零输入守卫：一个 target 都没扫到说明结构变了，检查已失去意义
  if (targetCount === 0) {
    problems.push({
      panel: "-",
      expr: "-",
      problem: "看板中未找到任何 target 表达式，检查已失去意义",
    });
  }
  return problems;
}

if (import.meta.main) {
  const problems = await checkDashboards(".");
  if (problems.length > 0) {
    console.error(`发现 ${problems.length} 条看板表达式问题:\n`);
    for (const p of problems) {
      console.error(`- [${p.panel}] ${p.problem}`);
      console.error(`  表达式: ${p.expr}\n`);
    }
    Deno.exit(1);
  }
  console.log("Grafana 看板表达式检查通过");
}
