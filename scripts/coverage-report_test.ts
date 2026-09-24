/**
 * coverage-report 聚合逻辑单元测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  parseCoverageLine,
  renderMarkdown,
  stripAnsi,
  summarizeModule,
} from "./coverage-report.ts";

const REAL_TABLE = `
| File      | Branch % | Function % | Line % |
| --------- | -------- | ---------- | ------ |
| m.ts      |    100.0 |      100.0 |  100.0 |
| lib/a.ts  |     80.0 |       50.0 |   90.0 |
`;

Deno.test("coverage-report: 解析 deno coverage 表格行", () => {
  const row = parseCoverageLine(
    "| lib/a.ts  |     80.0 |       50.0 |   90.0 |",
  );
  assertEquals(row?.module, "lib/a.ts");
  assertEquals(row?.branch_percent, 80);
  assertEquals(row?.function_percent, 50);
  assertEquals(row?.line_percent, 90);
});

Deno.test("coverage-report: 表头与分隔行返回 null", () => {
  assertEquals(
    parseCoverageLine("| File | Branch % | Function % | Line % |"),
    null,
  );
  assertEquals(parseCoverageLine("| --- | --- | --- | --- |"), null);
  assertEquals(parseCoverageLine("no table here"), null);
});

Deno.test("coverage-report: summarizeModule 取文件平均覆盖率", () => {
  const summary = summarizeModule("noj-ui", REAL_TABLE);
  assertEquals(summary?.module, "noj-ui");
  assertEquals(summary?.line_percent, 95);
  assertEquals(summary?.branch_percent, 90);
  assertEquals(summary?.function_percent, 75);
});

Deno.test("coverage-report: 无数据返回 null", () => {
  assertEquals(summarizeModule("noj-ui", "no coverage output"), null);
});

Deno.test("coverage-report: renderMarkdown 生成表格", () => {
  const md = renderMarkdown([
    {
      module: "noj-ui",
      branch_percent: 80,
      function_percent: 50,
      line_percent: 90,
    },
  ]);
  assertEquals(md.includes("| noj-ui | 90.0% | 80.0% | 50.0% |"), true);
});

// ── 2026-09-21 修复：TTY 下的 ANSI 转义码让整行解析失败 ──
// 触发条件：本地 TTY 运行 test:coverage 时 deno coverage 输出带颜色。
Deno.test("coverage-report: 带 ANSI 转义码的行也能解析", () => {
  const ansi = (s: string) => `\u001b[0m\u001b[32m${s}\u001b[0m`;
  const line = `| ${ansi("utils/x.ts")} | ${ansi("    100.0")} | ${
    ansi("      100.0")
  } | ${ansi("  100.0")} |`;
  const row = parseCoverageLine(line);
  assertEquals(row?.module, "utils/x.ts");
  assertEquals(row?.line_percent, 100);
});

Deno.test("coverage-report: 带 ANSI 的完整表格仍能汇总", () => {
  const ansi = (s: string) => `\u001b[0m\u001b[32m${s}\u001b[0m`;
  const table = [
    "| File | Branch % | Function % | Line % |",
    `| ${ansi("a.ts")} | ${ansi("   80.0")} | ${ansi("     50.0")} | ${
      ansi("  90.0")
    } |`,
    `| ${ansi("All files")} | ${ansi("   92.0")} | ${ansi("     93.0")} | ${
      ansi("  94.0")
    } |`,
  ].join("\n");
  const summary = summarizeModule("noj-ui", table);
  assertEquals(summary?.module, "noj-ui");
  assertEquals(summary?.line_percent, 94);
});

Deno.test("coverage-report: stripAnsi 清理 SGR 序列", () => {
  assertEquals(stripAnsi("\u001b[0m\u001b[32m100.0\u001b[0m"), "100.0");
  assertEquals(stripAnsi("no-ansi"), "no-ansi");
});
