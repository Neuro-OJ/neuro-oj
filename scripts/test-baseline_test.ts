/**
 * 慢测试基线记录逻辑单元测试。
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  formatDuration,
  parseBaselineArgs,
  renderBaseline,
  renderSuiteBaseline,
  type SuiteSummary,
  summarizeDurations,
} from "./test-baseline.ts";
import type { PerformanceReport } from "./test-performance-report.ts";

function emptyReport(): PerformanceReport {
  return {
    generatedAt: "2026-11-03T00:00:00.000Z",
    manifests: [],
    timings: {
      records: 10,
      files: 2,
      totalMs: 1000,
      failures: 0,
      phases: [],
      fileStats: [],
      caseStats: [],
    },
    junit: { tests: 5, failures: 0, errors: 0, skipped: 1, durationMs: 900 },
    dataQuality: {
      jsonlFiles: 2,
      invalidLines: 0,
      invalidFiles: [],
      missingManifest: true,
    },
  };
}

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

Deno.test("test-baseline: 参数解析与非法值", () => {
  const options = parseBaselineArgs([
    "--suite",
    "browser",
    "--repeat",
    "3",
    "--output",
    "out.md",
  ]);
  assertEquals(options.suite, "browser");
  assertEquals(options.repeat, 3);
  assertEquals(options.output, "out.md");
  assertThrows(
    () => parseBaselineArgs(["--suite", "unknown"]),
    Error,
    "--suite",
  );
  assertThrows(() => parseBaselineArgs(["--repeat", "0"]), Error, "--repeat");
  assertThrows(() => parseBaselineArgs(["--what"]), Error, "未知参数");
});

Deno.test("test-baseline: 中位数与范围", () => {
  assertEquals(summarizeDurations([300, 100, 200]), {
    medianMs: 200,
    minMs: 100,
    maxMs: 300,
  });
  assertEquals(summarizeDurations([100, 200]), {
    medianMs: 150,
    minMs: 100,
    maxMs: 200,
  });
  assertEquals(summarizeDurations([]), { medianMs: 0, minMs: 0, maxMs: 0 });
});

Deno.test("test-baseline: suite 报告包含失败退出码与 JUnit 数量", () => {
  const report = emptyReport();
  const summary: SuiteSummary = {
    suite: "core",
    repeat: 2,
    command: "deno task test:parallel --shards 4 --jobs 2 --profile",
    cwd: "noj-core",
    metadata: "commit=abc deno=2.9.5",
    runs: [
      {
        index: 1,
        exitCode: 0,
        durationMs: 60_000,
        timingDir: "/tmp/run-1",
        report,
      },
      {
        index: 2,
        exitCode: 1,
        durationMs: 90_000,
        timingDir: "/tmp/run-2",
        report,
      },
    ],
    medianMs: 75_000,
    minMs: 60_000,
    maxMs: 90_000,
  };
  const md = renderSuiteBaseline(summary);
  assertEquals(md.includes("suite=core"), true);
  assertEquals(md.includes("| #2 | 1 |"), true);
  assertEquals(md.includes("JUnit tests"), true);
  assertEquals(md.includes("首轮 vs 末轮"), true);
});
