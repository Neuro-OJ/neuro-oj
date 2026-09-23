/**
 * Grafana 看板表达式检查的单元测试。
 *
 * 覆盖两类真实缺陷：
 * 1. 裸用直方图家族名（panel 永远为空，静默失效）；
 * 2. 引用不存在的指标名（拼写错误）。
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  checkDashboards,
  checkExpression,
  collectDefinedMetrics,
  extractMetricNames,
  isExternalMetric,
} from "./check-dashboards.ts";

const DEFINED = new Map<string, "counter" | "gauge" | "histogram" | "unknown">([
  ["noj_http_requests_total", "counter"],
  ["noj_llm_request_duration_seconds", "histogram"],
]);

Deno.test("extractMetricNames: 提取指标名并排除标签值与函数名", () => {
  const names = extractMetricNames(
    'histogram_quantile(0.95, sum by (le) (rate(noj_llm_request_duration_seconds_bucket{result="accepted"}[5m])))',
  );
  assertEquals(names.includes("noj_llm_request_duration_seconds_bucket"), true);
  // 函数名与关键字不应被当作指标
  assertEquals(names.includes("histogram_quantile"), false);
  assertEquals(names.includes("rate"), false);
  assertEquals(names.includes("le"), false);
  // 标签值不应被当作指标
  assertEquals(names.includes("accepted"), false);
});

Deno.test("isExternalMetric: 标准导出器指标无需本仓库定义", () => {
  for (
    const n of ["node_cpu_seconds_total", "up", "process_resident_memory_bytes"]
  ) {
    assertEquals(isExternalMetric(n), true, `${n} 应视为外部指标`);
  }
  assertEquals(isExternalMetric("noj_http_requests_total"), false);
});

Deno.test("checkExpression: 裸用直方图家族名报错", () => {
  const problems = checkExpression(
    "测试面板",
    "noj_llm_request_duration_seconds",
    DEFINED,
  );
  assertEquals(problems.length, 1, JSON.stringify(problems));
  assertEquals(problems[0]!.problem.includes("裸用直方图家族名"), true);
});

Deno.test("checkExpression: histogram_quantile + _bucket 用法不报错", () => {
  const problems = checkExpression(
    "测试面板",
    "histogram_quantile(0.95, sum by (le) (rate(noj_llm_request_duration_seconds_bucket[5m])))",
    DEFINED,
  );
  assertEquals(problems, []);
});

Deno.test("checkExpression: 计数器的裸用是合法的", () => {
  const problems = checkExpression(
    "测试面板",
    "noj_http_requests_total",
    DEFINED,
  );
  assertEquals(problems, []);
});

Deno.test("checkExpression: 未定义指标报错", () => {
  const problems = checkExpression(
    "测试面板",
    "noj_typo_metric_total",
    DEFINED,
  );
  assertEquals(problems.length, 1);
  assertEquals(problems[0]!.problem.includes("未定义的指标"), true);
});

Deno.test("checkExpression: 直方图的 _sum/_count 直接使用是合法的", () => {
  for (
    const expr of [
      "rate(noj_llm_request_duration_seconds_sum[5m])",
      "rate(noj_llm_request_duration_seconds_count[5m])",
    ]
  ) {
    assertEquals(checkExpression("测试面板", expr, DEFINED), [], expr);
  }
});

Deno.test("check-dashboards: 真实看板无可报告问题", async () => {
  const problems = await checkDashboards(".");
  assertEquals(
    problems,
    [],
    `看板不应有问题，实际：${JSON.stringify(problems)}`,
  );
});

Deno.test("check-dashboards: 能真正发现指标定义（非空转）", async () => {
  const defined = await collectDefinedMetrics(".");
  // 直方图类型必须被识别（否则「裸用」检测会退化为恒真）
  assertEquals(
    defined.get("noj_llm_request_duration_seconds"),
    "histogram",
    "网关直方图类型应被识别",
  );
  assertEquals(
    defined.get("noj_submission_e2e_duration_seconds"),
    "histogram",
    "业务直方图类型应被识别（来自 registerBusinessMetric）",
  );
});

// ── 2026-09-21 修复：裸前缀匹配让 `up*` 拼错指标逃逸 ──
// 触发条件：dashboard 引用 `up` 开头的自造/拼错指标。
Deno.test("isExternalMetric: 不做裸前缀匹配（up*/postgres* 拼错不得放行）", () => {
  for (
    const n of [
      "upload_failed_requests_total",
      "uptime_seconds",
      "uptime_second", // 拼错
      "postgresql_x", // 不带下划线的自造名
    ]
  ) {
    assertEquals(
      isExternalMetric(n),
      false,
      `${n} 不得被当作外部指标（否则拼错指标永远不会被门禁发现）`,
    );
  }
  // 带下划线边界的仍视为外部
  for (
    const n of [
      "node_cpu_seconds_total",
      "process_resident_memory_bytes",
      "pg_stat_activity_count",
      "postgres_up",
      "redis_connected_clients",
      "up", // 精确匹配
    ]
  ) {
    assertEquals(isExternalMetric(n), true, `${n} 应视为外部指标`);
  }
});

Deno.test("checkExpression: 拼错的 up* 指标会被报为未定义", () => {
  const problems = checkExpression(
    "拼错面板",
    "sum(upload_failed_requests_total)",
    new Map(),
  );
  assert(
    problems.some((p) => p.problem.includes("引用了未定义的指标")),
    `拼错的 up* 指标必须报未定义，实际 ${JSON.stringify(problems)}`,
  );
});

// ── 2026-09-21 修复：兜底把任意 noj_* 字面量当定义（恒真断言）──
// 触发条件：源码里出现拼错/自造的 noj_* 字面量。
Deno.test("collectDefinedMetrics: 调用点字面量不得被当作指标定义", async () => {
  const root = await Deno.makeTempDir({ prefix: "dash-def-" });
  try {
    await Deno.mkdir(`${root}/noj-core/src`, { recursive: true });
    // 真实定义（name: "...", type 字段）
    await Deno.writeTextFile(
      `${root}/noj-core/src/real.ts`,
      `const d = { name: "noj_real_metric_total", type: "counter" };\n`,
    );
    // 调用点：只出现字面量，不是定义
    await Deno.writeTextFile(
      `${root}/noj-core/src/call.ts`,
      `inc("noj_typo_metric_xyz");\n`,
    );
    const defined = await collectDefinedMetrics(root);
    assertEquals(defined.has("noj_real_metric_total"), true);
    assertEquals(
      defined.has("noj_typo_metric_xyz"),
      false,
      "调用点字面量不得被登记为已定义（否则门禁恒真）",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("collectDefinedMetrics: 真实仓库不产生 unknown 兜底条目", async () => {
  const defined = await collectDefinedMetrics(".");
  const unknowns = [...defined.entries()].filter(([, t]) => t === "unknown");
  assertEquals(
    unknowns.length,
    0,
    `不应有仅凭字面量登记的 unknown 条目，实际 ${JSON.stringify(unknowns)}`,
  );
});
