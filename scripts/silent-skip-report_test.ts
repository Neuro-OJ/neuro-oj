/**
 * 静默跳过扫描逻辑单元测试。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  buildBaseline,
  compareWithBaseline,
  renderReport,
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
