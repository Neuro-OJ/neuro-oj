/**
 * Grafana 看板表达式检查的单元测试。
 *
 * 覆盖两类真实缺陷：
 * 1. 裸用直方图家族名（panel 永远为空，静默失效）；
 * 2. 引用不存在的指标名（拼写错误）。
 */

import { assertEquals } from "jsr:@std/assert@^1";
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
