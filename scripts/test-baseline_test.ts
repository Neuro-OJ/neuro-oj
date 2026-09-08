/**
 * 慢测试基线记录逻辑单元测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { formatDuration, renderBaseline } from "./test-baseline.ts";

Deno.test("test-baseline: formatDuration 格式化毫秒", () => {
  assertEquals(formatDuration(90_000), "1m30s");
  assertEquals(formatDuration(5_000), "5s");
});

Deno.test("test-baseline: renderBaseline 生成 Markdown", () => {
  const md = renderBaseline([
    { module: "noj-core", command: "deno task test:smoke", durationMs: 5_000 },
  ]);
  assertEquals(md.includes("| noj-core | deno task test:smoke | 5s |"), true);
});
