import { checkMetricCalls } from "./check-metrics.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("check-metrics: 未定义指标写入报错", () => {
  const errors = checkMetricCalls(
    `import { observability } from "./write.ts";\nobservability.inc("noj_unknown_total");\n`,
    new Set(["noj_known_total"]),
  );
  assert(errors.length > 0, "未定义指标应报错");
});

Deno.test("check-metrics: metrics alias 的未定义写入同样报错", () => {
  const errors = checkMetricCalls(
    `import { observability as metrics } from "./write.ts";\nmetrics.inc("noj_unknown_total");\n`,
    new Set(["noj_known_total"]),
  );
  assert(errors.length > 0, "metrics alias 未定义指标应报错");
});

Deno.test("check-metrics: 带标签的写入也要被检查", () => {
  const errors = checkMetricCalls(
    `observability.inc("noj_unknown_total", { route: "/x", status: "500" });\n`,
    new Set(["noj_known_total"]),
  );
  assert(errors.length > 0, "带标签的未定义写入应报错");
});

Deno.test("check-metrics: 带增量的写入也要被检查", () => {
  const errors = checkMetricCalls(
    `registry.observe("noj_unknown_seconds", 1.5);\n`,
    new Set(["noj_known_total"]),
  );
  assert(errors.length > 0, "带增量的未定义写入应报错");
});

Deno.test("check-metrics: 已注册指标不报错", () => {
  const errors = checkMetricCalls(
    `observability.inc("noj_known_total", { route: "/x" });\n` +
      `observability.set("noj_known_total", 1);\n`,
    new Set(["noj_known_total"]),
  );
  assert(
    errors.length === 0,
    `已注册指标不应报错，实际: ${JSON.stringify(errors)}`,
  );
});
