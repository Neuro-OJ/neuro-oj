/**
 * 静默跳过扫描逻辑单元测试。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  buildBaseline,
  compareWithBaseline,
  renderReport,
  SCAN_ROOTS,
  scanFile,
  type SkipHit,
} from "./silent-skip-report.ts";

function hit(file: string, reason: SkipHit["reason"] = "ignore"): SkipHit {
  return { file, line: 1, reason };
}

Deno.test("silent-skip: 识别 ignore / env-guard / early-return / rust", () => {
  const source = `
Deno.test({ name: "a", ignore: true, fn: () => {} });
Deno.test("b", { ignore: Deno.env.get("DATABASE_URL") ? false : true }, () => {});
if (!Deno.env.get("JWT_SECRET")) return;
e2eTest("[e2e/x] y", async () => {
  if (!isE2E || !judgeOk) return;
  console.log("  ⚠ judge 不可用，跳过");
});
#[ignore]
fn e2e_x() { if !is_e2e_enabled() { return; } }
`;
  const hits = scanFile("tests/demo_test.ts", source);
  const reasons = new Set(hits.map((h) => h.reason));
  assertEquals(reasons.has("ignore"), true);
  assertEquals(reasons.has("env-guard"), true);
  assertEquals(reasons.has("early-return"), true);
  assertEquals(reasons.has("rust-ignore"), true);
  assertEquals(reasons.has("rust-env-guard"), true);
});

Deno.test("silent-skip: 每个命中行只记一条原因", () => {
  const hits = scanFile("a.ts", 'if (!isE2E) return; console.log("跳过");');
  assertEquals(hits.length, 1);
  assertEquals(hits[0].reason, "early-return");
});

Deno.test("silent-skip: renderReport 生成 Markdown", () => {
  const md = renderReport([
    { file: "tests/a_test.ts", line: 3, reason: "ignore" },
  ]);
  assertEquals(md.includes("tests/a_test.ts"), true);
});

Deno.test("silent-skip: 数量未变时通过", () => {
  const hits = [hit("a.ts"), hit("a.ts"), hit("b.ts")];
  const baseline = buildBaseline(hits);
  assertEquals(baseline.total, 3);
  assertEquals(compareWithBaseline(hits, baseline), []);
});

Deno.test("silent-skip: 总数增长时失败", () => {
  const baseline = buildBaseline([hit("a.ts")]);
  const errors = compareWithBaseline([hit("a.ts"), hit("b.ts")], baseline);
  assert(errors.length > 0, "总数增长必须失败");
  assert(errors.some((e) => e.includes("增长")), JSON.stringify(errors));
});

Deno.test("silent-skip: 数量下降时通过（允许改进）", () => {
  const baseline = buildBaseline([hit("a.ts"), hit("b.ts")]);
  assertEquals(compareWithBaseline([hit("a.ts")], baseline), []);
});

Deno.test("silent-skip: 文件间此消彼长也能发现（总数不变）", () => {
  const baseline = buildBaseline([
    hit("a.ts"),
    hit("a.ts"),
    hit("b.ts"),
    hit("b.ts"),
  ]);
  const errors = compareWithBaseline(
    [hit("a.ts"), hit("b.ts"), hit("b.ts"), hit("c.ts")],
    baseline,
  );
  assert(
    errors.some((e) => e.includes("c.ts")),
    `新增文件的跳过必须被发现：${JSON.stringify(errors)}`,
  );
});

Deno.test("silent-skip: 原因分类增长时失败", () => {
  const baseline = buildBaseline([hit("a.ts", "ignore")]);
  const errors = compareWithBaseline(
    [hit("a.ts", "ignore"), hit("a.ts", "env-guard")],
    baseline,
  );
  assert(errors.some((e) => e.includes("env-guard")), JSON.stringify(errors));
});

Deno.test("silent-skip: 基线非零而当前为 0 判定扫描器失效", () => {
  const baseline = buildBaseline([hit("a.ts")]);
  const errors = compareWithBaseline([], baseline);
  assert(
    errors.some((e) => e.includes("扫描规则很可能已失效")),
    `必须有失效自检：${JSON.stringify(errors)}`,
  );
});

Deno.test("silent-skip: 基线为 0 且当前为 0 属正常", () => {
  assertEquals(compareWithBaseline([], buildBaseline([])), []);
});

// ── 扫描根覆盖（2026-09-21：noj-cli 曾是盲区）────────────────────────────
Deno.test("silent-skip: 扫描根包含 noj-cli（正式模块不得被门禁遗漏）", () => {
  assert(
    (SCAN_ROOTS as readonly string[]).includes("noj-cli"),
    `noj-cli 必须被扫描，否则其新增 ignore 不会被发现：${
      JSON.stringify(SCAN_ROOTS)
    }`,
  );
});

Deno.test("silent-skip: 扫描根覆盖全部一等模块（防再次遗漏）", () => {
  for (
    const mod of [
      "noj-core",
      "noj-ui",
      "noj-llm-gateway",
      "noj-tests",
      "noj-judge",
      "noj-cli",
    ]
  ) {
    assert(
      (SCAN_ROOTS as readonly string[]).includes(mod),
      `扫描根缺少模块 ${mod}`,
    );
  }
});

Deno.test("silent-skip: noj-cli 的 ignore 能被扫描到（端到端）", async () => {
  const dir = await Deno.makeTempDir({ prefix: "silent-skip-cli-" });
  try {
    await Deno.mkdir(`${dir}/noj-cli/src`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/noj-cli/src/demo_test.ts`,
      `Deno.test({ name: "x", ignore: true, fn: () => {} });\n`,
    );
    // 直接复用 scanFile 验证规则；SCAN_ROOTS 的接线由上面的断言保证。
    const hits = scanFile(
      `${dir}/noj-cli/src/demo_test.ts`,
      await Deno.readTextFile(`${dir}/noj-cli/src/demo_test.ts`),
    );
    assertEquals(hits.length, 1);
    assertEquals(hits[0]!.reason, "ignore");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── 2026-09-21 修复：`ignore: <标识符>` 整类写法失明 ──
// 触发条件：守卫由变量承载（仓库中数量最多的一类写法）。
Deno.test("silent-skip: 识别 ignore: <标识符>（变量守卫）", () => {
  const source = [
    `const skip = !(hasDb && hasJwt);`,
    `Deno.test({ name: "a", ignore: skip, fn: () => {} });`,
    `Deno.test({ name: "b", ignore: skipDb, fn: () => {} });`,
    `Deno.test({ name: "c", ignore: skipEnv, fn: () => {} });`,
    `Deno.test({ name: "d", ignore: skipDb || skipEnv, fn: () => {} });`,
    `Deno.test({ name: "e", ignore: skip || !hasRedis, fn: () => {} });`,
  ].join("\n");
  const hits = scanFile("tests/demo_test.ts", source);
  assertEquals(
    hits.length,
    5,
    `5 条 ignore:<标识符> 都应命中，实际 ${hits.length}: ${
      JSON.stringify(hits)
    }`,
  );
  assertEquals(hits.every((h) => h.reason === "ignore"), true);
});

Deno.test("silent-skip: ignore: true / false / ! 的分类不被新规则改变", () => {
  assertEquals(scanFile("a.ts", `ignore: true,`)[0]!.reason, "ignore");
  assertEquals(scanFile("a.ts", `ignore: !isE2E,`)[0]!.reason, "ignore");
  assertEquals(
    scanFile("a.ts", `ignore: Deno.env.get("X"),`)[0]!.reason,
    "env-guard",
  );
  // 显式 false 不应命中（否则基线会被噪声灌满）
  assertEquals(scanFile("a.ts", `ignore: false,`).length, 0);
});

Deno.test("silent-skip: 真实仓库的变量守卫文件被计入", async () => {
  // 防回归：这两个文件此前零命中，是全仓库最典型的整文件环境守卫。
  const real = await Deno.readTextFile(
    "noj-core/src/domains/messaging/tests/routes/messages.test.ts",
  );
  const hits = scanFile(
    "noj-core/src/domains/messaging/tests/routes/messages.test.ts",
    real,
  );
  assertEquals(
    hits.length > 0,
    true,
    `messages.test.ts 的 ignore: skip 应被计入，实际 ${hits.length}`,
  );
  const audit = await Deno.readTextFile(
    "noj-core/src/domains/system/tests/services/audit-log.test.ts",
  );
  assertEquals(scanFile("audit-log.test.ts", audit).length > 0, true);
});
