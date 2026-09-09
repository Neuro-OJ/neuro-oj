/**
 * coverage-report 聚合逻辑单元测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  parseCoverageLine,
  renderMarkdown,
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
