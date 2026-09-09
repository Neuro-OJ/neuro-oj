/**
 * 静默跳过扫描逻辑单元测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { renderReport, scanFile } from "./silent-skip-report.ts";

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
