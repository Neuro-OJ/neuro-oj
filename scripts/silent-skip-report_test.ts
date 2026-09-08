/**
 * 静默跳过扫描逻辑单元测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { scanFile, renderReport } from "./silent-skip-report.ts";

Deno.test("silent-skip: scanFile 识别 ignore/skip 与环境变量守卫", () => {
  const source = `
Deno.test({ name: "a", ignore: true, fn: () => {} });
Deno.test("b", { ignore: Deno.env.get("DATABASE_URL") ? false : true }, () => {});
if (!Deno.env.get("JWT_SECRET")) return;
`;
  const hits = scanFile("tests/demo_test.ts", source);
  assertEquals(hits.some((h) => h.reason === "ignore"), true);
  assertEquals(hits.some((h) => h.reason === "env-guard"), true);
});

Deno.test("silent-skip: renderReport 生成 Markdown", () => {
  const md = renderReport([
    { file: "tests/a_test.ts", line: 3, reason: "ignore" },
  ]);
  assertEquals(md.includes("tests/a_test.ts"), true);
});
