/**
 * 性能报告聚合单元测试。
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  aggregateTimings,
  buildReport,
  compareReports,
  parseJUnitXml,
  parseTimingJsonl,
  percentile,
  renderPerformanceMarkdown,
} from "./test-performance-report.ts";
import type { TestTimingRecord } from "./lib/test-timing.ts";

function record(overrides: Partial<TestTimingRecord> = {}): TestTimingRecord {
  return {
    version: 1,
    runId: "run-1",
    shard: "core",
    phase: "db:reset",
    durationMs: 100,
    success: true,
    ...overrides,
  };
}

Deno.test("performance-report: JSONL 坏行计数但不中断", () => {
  const parsed = parseTimingJsonl([
    JSON.stringify(record()),
    "",
    "{坏行",
    JSON.stringify({ version: 2, phase: "x" }),
    JSON.stringify(record({ phase: "browser:launch", durationMs: 5 })),
  ].join("\n"));
  assertEquals(parsed.records.length, 2);
  assertEquals(parsed.invalidLines, 2);
});

Deno.test("performance-report: 阶段/文件/用例聚合与百分位", () => {
  const aggregated = aggregateTimings([
    record({ durationMs: 10, file: "a.test.ts", caseName: "case-a" }),
    record({ durationMs: 20, file: "a.test.ts", caseName: "case-a" }),
    record({
      durationMs: 30,
      file: "b.test.ts",
      caseName: "case-b",
      phase: "browser:launch",
    }),
    record({ durationMs: 5, success: false, file: "a.test.ts" }),
  ]);
  assertEquals(aggregated.records, 4);
  assertEquals(aggregated.failures, 1);
  assertEquals(aggregated.files, 2);
  assertEquals(aggregated.totalMs, 65);
  const reset = aggregated.phases.find((phase) => phase.phase === "db:reset")!;
  assertEquals(reset.count, 3);
  assertEquals(reset.totalMs, 35);
  assertEquals(reset.medianMs, 10);
  assertEquals(reset.maxMs, 20);
  const fileA = aggregated.fileStats.find((file) => file.file === "a.test.ts")!;
  assertEquals(fileA.totalMs, 35);
  assertEquals(percentile([1, 2, 3, 4, 5], 95), 5);
  assertEquals(percentile([], 95), 0);
});

Deno.test("performance-report: JUnit 统计 testcase 而非嵌套 suite 属性", () => {
  const xml = `<?xml version="1.0"?>
<testsuites tests="99">
  <testsuite tests="2" failures="0" time="3">
    <testcase name="a" time="1"/>
    <testcase name="b" time="2"><failure message="x"/></testcase>
  </testsuite>
  <testsuite tests="1" time="0.5">
    <testcase name="c" time="0.5"><skipped/></testcase>
  </testsuite>
</testsuites>`;
  const summary = parseJUnitXml(xml);
  assertEquals(summary.tests, 3);
  assertEquals(summary.failures, 1);
  assertEquals(summary.skipped, 1);
  assertEquals(summary.durationMs, 3500);
});

Deno.test("performance-report: 从目录构建报告并渲染 Markdown", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const runDir = `${dir}/run-1`;
    await Deno.mkdir(runDir, { recursive: true });
    await Deno.writeTextFile(
      `${runDir}/core-1.jsonl`,
      JSON.stringify(record({ file: "tests/a.test.ts", caseName: "用例 A" })) +
        "\n",
    );
    await Deno.writeTextFile(
      `${runDir}/manifest.json`,
      JSON.stringify({
        version: 1,
        runId: "run-1",
        suite: "core",
        command: "deno task test:parallel --profile",
        denoVersion: "2.9.5",
        concurrency: { shards: 4, jobs: 2 },
        selected: ["tests/a.test.ts"],
        executed: ["tests/a.test.ts"],
        junit: [`${runDir}/junit.xml`],
        exitCode: 0,
      }),
    );
    await Deno.writeTextFile(
      `${runDir}/junit.xml`,
      `<testsuite><testcase name="用例 A" time="0.1"/></testsuite>`,
    );
    const report = await buildReport({ timingDir: dir });
    assertEquals(report.manifests.length, 1);
    assertEquals(report.timings.records, 1);
    assertEquals(report.junit?.tests, 1);
    assertEquals(report.dataQuality.missingManifest, false);
    const markdown = renderPerformanceMarkdown(report, { top: 5 });
    assertEquals(markdown.includes("## 阶段耗时"), true);
    assertEquals(markdown.includes("db:reset"), true);
    assertEquals(markdown.includes("用例 A"), true);
    assertEquals(markdown.includes("deno task test:parallel --profile"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("performance-report: 对比能区分测试变少与单用例变快", async () => {
  const before = await buildReport({ timingDir: "/nonexistent-before" });
  const after = await buildReport({ timingDir: "/nonexistent-after" });
  before.junit = {
    tests: 100,
    failures: 0,
    errors: 0,
    skipped: 0,
    durationMs: 0,
  };
  after.junit = {
    tests: 50,
    failures: 0,
    errors: 0,
    skipped: 0,
    durationMs: 0,
  };
  before.timings.totalMs = 10_000;
  before.timings.records = 100;
  after.timings.totalMs = 2_000;
  after.timings.records = 50;
  const rows = compareReports(before, after);
  const tests = rows.find((row) => row.metric === "JUnit tests")!;
  assertEquals(tests.change, "-50.0%");
  const avg = rows.find((row) => row.metric === "每条记录平均(ms)")!;
  assertEquals(avg.before, 100);
  assertEquals(avg.after, 40);
  assertEquals(avg.change, "-60.0%");
});

Deno.test("performance-report: JUnit 按文件汇总耗时", () => {
  const xml = `<testsuites name="deno test" tests="3">
  <testsuite name="./tests/a.test.ts" tests="2" failures="1" disabled="0" time="3">
    <testcase name="a" classname="./tests/a.test.ts" time="1"/>
    <testcase name="b" classname="./tests/a.test.ts" time="2"><failure/></testcase>
  </testsuite>
  <testsuite name="./tests/b.test.ts" tests="1" failures="0" disabled="1" time="0.5">
    <testcase name="c" classname="./tests/b.test.ts" time="0.5"><skipped/></testcase>
  </testsuite>
</testsuites>`;
  const summary = parseJUnitXml(xml);
  assertEquals(summary.files?.length, 2);
  assertEquals(summary.files?.[0].file, "tests/a.test.ts");
  assertEquals(summary.files?.[0].durationMs, 3000);
  assertEquals(summary.files?.[0].failures, 1);
  assertEquals(summary.files?.[1].skipped, 1);
});

Deno.test("performance-report: 缺失目录返回空报告不抛错", async () => {
  const report = await buildReport({ timingDir: "/definitely/missing" });
  assertEquals(report.timings.records, 0);
  assertEquals(report.dataQuality.missingManifest, true);
});
