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
