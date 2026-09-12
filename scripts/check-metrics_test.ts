import { checkMetricCalls, checkMetricCatalogDoc } from "./check-metrics.ts";

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

Deno.test("check-metrics: 任意接收者变量名都要被检查", () => {
  // app.ts 的真实形态是 observabilityRegistry.inc(...)；按接收者枚举会漏检。
  for (const receiver of ["observabilityRegistry", "obs", "sink", "self"]) {
    const errors = checkMetricCalls(
      `${receiver}.inc("noj_unknown_total", { route: "/x" });\n`,
      new Set(["noj_known_total"]),
    );
    assert(errors.length > 0, `接收者 ${receiver} 的未定义写入应报错`);
  }
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

Deno.test("check-metrics: 无接收者的裸调用也要被检查（网关写法）", () => {
  // noj-llm-gateway 直接 import 模块函数：`inc("noj_...")`。
  // 此前的正则强制要求前导 `.`，网关全部写入点都匹配不到（门禁对它形同虚设）。
  const errors = checkMetricCalls(
    `import { inc } from "../metrics.ts";\ninc("noj_unknown_total");\n`,
    new Set(["noj_known_total"]),
  );
  assert(errors.length > 0, "裸调用的未定义指标应报错");
});

Deno.test("check-metrics: 裸调用的 observe 带标签与增量也要被检查", () => {
  const errors = checkMetricCalls(
    `observe("noj_unknown_seconds", 1.5, { provider: "x" });\n`,
    new Set(["noj_known_seconds"]),
  );
  assert(errors.length > 0, "裸调用 observe 的未定义指标应报错");
});

Deno.test("check-metrics: 裸调用的已定义指标不报错", () => {
  const errors = checkMetricCalls(
    `inc("noj_known_total", {}, 3);\nobserve("noj_known_seconds", 0.4);\n`,
    new Set(["noj_known_total", "noj_known_seconds"]),
  );
  assert(
    errors.length === 0,
    `已定义指标不应报错，实际: ${JSON.stringify(errors)}`,
  );
});

Deno.test("check-metrics: 无关的 set/inc 调用不误报", () => {
  // 放宽接收者后必须确认不会把普通的 Map/Set 操作误判为指标写入：
  // 模式强制要求 `"noj_` 字面量紧随左括号，故这些都不匹配。
  const errors = checkMetricCalls(
    `cache.set("key", 1);\nmap.inc("other_name");\nseries.add("x");\n`,
    new Set<string>(),
  );
  assert(
    errors.length === 0,
    `非指标写入不应报错，实际: ${JSON.stringify(errors)}`,
  );
});

Deno.test("check-metrics: catalog 文档缺失平台指标时失败", () => {
  const errors = checkMetricCatalogDoc(
    "## 平台指标\n\n| 指标 |\n| --- |\n| `noj_a_total` |\n",
    ["noj_a_total", "noj_b_total"],
    new Set(["noj_a_total", "noj_b_total"]),
  );
  assert(errors.length > 0, "缺失指标必须报错");
  assert(
    errors.some((e) => e.includes("noj_b_total")),
    `错误应指出缺失项：${JSON.stringify(errors)}`,
  );
});

Deno.test("check-metrics: catalog 文档登记未注册指标时失败", () => {
  const errors = checkMetricCatalogDoc(
    "| `noj_a_total` |\n| `noj_ghost_total` |\n",
    ["noj_a_total"],
    new Set(["noj_a_total"]),
  );
  assert(
    errors.some((e) => e.includes("noj_ghost_total")),
    `未注册指标必须报错：${JSON.stringify(errors)}`,
  );
});

Deno.test("check-metrics: catalog 文档名集合一致时通过", () => {
  const errors = checkMetricCatalogDoc(
    "| `noj_a_total` |\n| `noj_b_total` |\n",
    ["noj_a_total", "noj_b_total"],
    new Set(["noj_a_total", "noj_b_total"]),
  );
  assert(errors.length === 0, `不应报错，实际: ${JSON.stringify(errors)}`);
});

Deno.test("check-metrics: catalog 文档无指标名时判定门禁空转", () => {
  const errors = checkMetricCatalogDoc(
    "## 平台指标\n\n（表格被误删）\n",
    ["noj_a_total"],
    new Set(["noj_a_total"]),
  );
  assert(
    errors.some((e) => e.includes("未找到任何")),
    `空文档必须失败：${JSON.stringify(errors)}`,
  );
});
