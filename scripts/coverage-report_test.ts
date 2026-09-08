/**
 * coverage-report 聚合逻辑单元测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { parseCoverageSummary, renderMarkdown } from "./coverage-report.ts";

Deno.test("coverage-report: parseCoverageSummary 解析 Deno coverage 行", () => {
  const line = "  noj-ui  |  60.00%  |  120/200";
  const summary = parseCoverageSummary(line);
  assertEquals(summary.module, "noj-ui");
  assertEquals(summary.percent, 60);
  assertEquals(summary.covered, 120);
  assertEquals(summary.total, 200);
});

Deno.test("coverage-report: renderMarkdown 生成表格", () => {
  const md = renderMarkdown([
    { module: "noj-core", percent: 75, covered: 300, total: 400 },
    { module: "noj-ui", percent: 60, covered: 120, total: 200 },
  ]);
  assertEquals(md.includes("| noj-core | 75% | 300/400 |"), true);
  assertEquals(md.includes("| noj-ui | 60% | 120/200 |"), true);
});
