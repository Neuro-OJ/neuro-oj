/**
 * 测试性能报告聚合（P0）。
 *
 * 输入三样东西：
 * 1. 测试 isolate 写出的阶段计时 JSONL（`scripts/lib/test-timing.ts`）；
 * 2. 启动器写出的运行清单 `manifest.json`（命令、提交、并发度、选中文件、canary）；
 * 3. Deno 生成的 JUnit XML（通过/失败/跳过数量）。
 *
 * 输出同时包含机器可读 JSON 与人工可读 Markdown。报告刻意区分"测试变少"
 * （JUnit tests / executed 文件数）、"单用例变快"（每条记录平均耗时）和
 * "并行度增加"（manifest.concurrency），避免用墙钟差值得出错误结论。
 */
import type { TestTimingRecord } from "./lib/test-timing.ts";

/** 启动器写出的运行清单。字段缺失时报告仍可生成，但会标记数据不完整。 */
export interface TestRunManifest {
  version?: 1;
  runId?: string;
  suite?: string;
  command?: string;
  commit?: string;
  denoVersion?: string;
  runner?: { os?: string; arch?: string; ci?: boolean };
  concurrency?: {
    jobs?: number;
    shards?: number;
    /** Browser 分组数（P6-A）；与 shards 分开记录，便于区分编排层级。 */
    groups?: number;
    filter?: string;
  };
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  discovered?: string[];
  selected?: string[];
  executed?: string[];
  junit?: string[];
  canary?: {
    runId?: string;
    submissionId?: string;
    attemptId?: string;
    result?: string;
  } | null;
  exitCode?: number;
  reusedSession?: boolean;
}

/** JUnit 的逐文件统计（来自 `<testsuite name="<file>">`）。 */
export interface JUnitFileStat {
  file: string;
  tests: number;
  failures: number;
  skipped: number;
  durationMs: number;
}

/** JUnit 汇总。 */
export interface JUnitSummary {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  durationMs: number;
  /** 逐文件耗时；条目缺失时报告只展示汇总。 */
  files?: JUnitFileStat[];
}

/** 单个阶段的统计。 */
export interface PhaseStat {
  phase: string;
  count: number;
  totalMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  failures: number;
}

/** 单个文件的累计耗时。 */
export interface FileStat {
  file: string;
  records: number;
  totalMs: number;
  maxMs: number;
}

/** 单个用例的累计耗时。 */
export interface CaseStat {
  caseName: string;
  file?: string;
  records: number;
  totalMs: number;
  maxMs: number;
}

/** 聚合后的计时结果。 */
export interface AggregatedTimings {
  records: number;
  files: number;
  totalMs: number;
  failures: number;
  phases: PhaseStat[];
  fileStats: FileStat[];
  caseStats: CaseStat[];
}

/** 完整报告。 */
export interface PerformanceReport {
  generatedAt: string;
  manifests: TestRunManifest[];
  timings: AggregatedTimings;
  junit: JUnitSummary | null;
  dataQuality: {
    jsonlFiles: number;
    invalidLines: number;
    invalidFiles: string[];
    missingManifest: boolean;
  };
}

/** 计时目录读取结果。 */
export interface TimingReadResult {
  records: TestTimingRecord[];
  jsonlFiles: number;
  invalidLines: number;
  invalidFiles: string[];
}

/** 前后对比的一行。 */
export interface ComparisonRow {
  metric: string;
  before: number;
  after: number;
  /** 百分比变化，before 为 0 时为 `-`。 */
  change: string;
}

/** 报告渲染参数。 */
export interface RenderOptions {
  top?: number;
  title?: string;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 最近秩百分位；空数组返回 0。 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index]!;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/** 解析单个 JSONL 文本；坏行计数但不让整份报告失败。 */
export function parseTimingJsonl(text: string): {
  records: TestTimingRecord[];
  invalidLines: number;
} {
  const records: TestTimingRecord[] = [];
  let invalidLines = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<TestTimingRecord>;
      if (
        parsed.version !== 1 || typeof parsed.phase !== "string" ||
        typeof parsed.durationMs !== "number" ||
        typeof parsed.runId !== "string" || typeof parsed.shard !== "string"
      ) {
        invalidLines++;
        continue;
      }
      records.push({
        version: 1,
        runId: parsed.runId,
        shard: parsed.shard,
        phase: parsed.phase,
        durationMs: parsed.durationMs,
        success: parsed.success !== false,
        ...(typeof parsed.file === "string" ? { file: parsed.file } : {}),
        ...(typeof parsed.caseName === "string"
          ? { caseName: parsed.caseName }
          : {}),
        ...(typeof parsed.count === "number" ? { count: parsed.count } : {}),
      });
    } catch {
      invalidLines++;
    }
  }
  return { records, invalidLines };
}

async function listJsonlFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.isFile && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  await walk(directory.replace(/\/+$/, ""));
  return files.sort();
}

/** 读取目录下全部 JSONL；坏行/坏文件单独计数。 */
export async function readTimingRecords(
  directory: string,
): Promise<TimingReadResult> {
  const files = await listJsonlFiles(directory);
  const records: TestTimingRecord[] = [];
  const invalidFiles: string[] = [];
  let invalidLines = 0;
  for (const file of files) {
    try {
      const parsed = parseTimingJsonl(await Deno.readTextFile(file));
      records.push(...parsed.records);
      invalidLines += parsed.invalidLines;
    } catch {
      invalidFiles.push(file);
    }
  }
  return {
    records,
    jsonlFiles: files.length,
    invalidLines,
    invalidFiles,
  };
}

/** 聚合阶段、文件、用例三个维度。 */
export function aggregateTimings(
  records: TestTimingRecord[],
): AggregatedTimings {
  const byPhase = new Map<string, TestTimingRecord[]>();
  const byFile = new Map<string, TestTimingRecord[]>();
  const byCase = new Map<string, TestTimingRecord[]>();
  let totalMs = 0;
  let failures = 0;
  for (const record of records) {
    totalMs += record.durationMs;
    if (!record.success) failures++;
    const phaseRecords = byPhase.get(record.phase) ?? [];
    phaseRecords.push(record);
    byPhase.set(record.phase, phaseRecords);
    if (record.file) {
      const fileRecords = byFile.get(record.file) ?? [];
      fileRecords.push(record);
      byFile.set(record.file, fileRecords);
    }
    if (record.caseName) {
      const key = `${record.file ?? ""}::${record.caseName}`;
      const caseRecords = byCase.get(key) ?? [];
      caseRecords.push(record);
      byCase.set(key, caseRecords);
    }
  }

  const phases: PhaseStat[] = [...byPhase.entries()].map(([phase, list]) => {
    const durations = list.map((record) => record.durationMs);
    return {
      phase,
      count: list.length,
      totalMs: round(durations.reduce((sum, value) => sum + value, 0)),
      medianMs: round(median(durations)),
      p95Ms: round(percentile(durations, 95)),
      maxMs: round(Math.max(...durations)),
      failures: list.filter((record) => !record.success).length,
    };
  }).sort((a, b) => b.totalMs - a.totalMs || a.phase.localeCompare(b.phase));

  const fileStats: FileStat[] = [...byFile.entries()].map(([file, list]) => ({
    file,
    records: list.length,
    totalMs: round(list.reduce((sum, record) => sum + record.durationMs, 0)),
    maxMs: round(Math.max(...list.map((record) => record.durationMs))),
  })).sort((a, b) => b.totalMs - a.totalMs || a.file.localeCompare(b.file));

  const caseStats: CaseStat[] = [...byCase.entries()].map(([, list]) => {
    const sample = list[0]!;
    return {
      caseName: sample.caseName!,
      ...(sample.file ? { file: sample.file } : {}),
      records: list.length,
      totalMs: round(list.reduce((sum, record) => sum + record.durationMs, 0)),
      maxMs: round(Math.max(...list.map((record) => record.durationMs))),
    };
  }).sort((a, b) =>
    b.totalMs - a.totalMs || a.caseName.localeCompare(b.caseName)
  );

  return {
    records: records.length,
    files: fileStats.length,
    totalMs: round(totalMs),
    failures,
    phases,
    fileStats,
    caseStats,
  };
}

/**
 * 解析 JUnit XML。
 *
 * Deno 的 JUnit reporter 会生成嵌套 testsuite；这里统计 testcase 标签而不是读根
 * 属性，避免嵌套 suite 重复计数。时间取各 testcase 的 time 之和（秒 → 毫秒）。
 */
function xmlAttr(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match?.[1];
}

function xmlNumber(source: string, name: string): number {
  const raw = xmlAttr(source, name);
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

export function parseJUnitXml(xml: string): JUnitSummary {
  const tests = (xml.match(/<testcase\b/g) ?? []).length;
  const failures = (xml.match(/<failure\b/g) ?? []).length;
  const errors = (xml.match(/<error\b/g) ?? []).length;
  const skipped = (xml.match(/<skipped\b/g) ?? []).length;
  let durationMs = 0;
  for (const match of xml.matchAll(/<testcase\b[^>]*\btime="([^"]+)"/g)) {
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds)) durationMs += seconds * 1000;
  }
  if (durationMs === 0) {
    for (const match of xml.matchAll(/<testsuite\b[^>]*\btime="([^"]+)"/g)) {
      const seconds = Number(match[1]);
      if (Number.isFinite(seconds)) durationMs += seconds * 1000;
    }
  }

  // Deno 的 <testsuite name="./path"> 不带 time；逐文件耗时必须累加 testcase 的
  // classname/time，suite 只提供 failures/disabled 计数。
  const byFile = new Map<string, JUnitFileStat>();
  for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const attrs = match[1]!;
    const raw = xmlAttr(attrs, "name");
    if (!raw || raw === "deno test") continue;
    const file = raw.replace(/^\.\//, "");
    byFile.set(file, {
      file,
      tests: xmlNumber(attrs, "tests"),
      failures: xmlNumber(attrs, "failures"),
      skipped: xmlNumber(attrs, "disabled"),
      durationMs: round(xmlNumber(attrs, "time") * 1000),
    });
  }
  const caseDurations = new Map<string, number>();
  const caseCounts = new Map<string, number>();
  for (const match of xml.matchAll(/<testcase\b([^>]*)>/g)) {
    const attrs = match[1]!;
    const raw = xmlAttr(attrs, "classname");
    if (!raw) continue;
    const file = raw.replace(/^\.\//, "");
    const seconds = xmlNumber(attrs, "time");
    caseDurations.set(file, (caseDurations.get(file) ?? 0) + seconds * 1000);
    caseCounts.set(file, (caseCounts.get(file) ?? 0) + 1);
  }
  for (const [file, duration] of caseDurations) {
    const existing = byFile.get(file);
    byFile.set(file, {
      file,
      tests: existing?.tests || caseCounts.get(file) || 0,
      failures: existing?.failures ?? 0,
      skipped: existing?.skipped ?? 0,
      durationMs: round(duration),
    });
  }
  const files = [...byFile.values()].sort((a, b) =>
    b.durationMs - a.durationMs || a.file.localeCompare(b.file)
  );

  return {
    tests,
    failures,
    errors,
    skipped,
    durationMs: round(durationMs),
    ...(files.length > 0 ? { files } : {}),
  };
}

async function readManifests(directory: string): Promise<TestRunManifest[]> {
  const manifests: TestRunManifest[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.isFile && entry.name === "manifest.json") {
        try {
          const parsed = JSON.parse(await Deno.readTextFile(path));
          if (parsed && typeof parsed === "object") {
            manifests.push(parsed as TestRunManifest);
          }
        } catch {
          // 清单损坏按缺失处理，由 dataQuality.missingManifest 暴露。
        }
      }
    }
  }
  await walk(directory.replace(/\/+$/, ""));
  return manifests;
}

/** 构建报告；目录不存在时返回空报告而不是抛错。 */
export async function buildReport(options: {
  timingDir: string;
  junitFiles?: string[];
}): Promise<PerformanceReport> {
  const timing = await readTimingRecords(options.timingDir);
  const manifests = await readManifests(options.timingDir);
  const junitPaths = options.junitFiles?.length
    ? options.junitFiles
    : manifests.flatMap((manifest) => manifest.junit ?? []);
  let junit: JUnitSummary | null = null;
  for (const path of junitPaths) {
    try {
      const parsed = parseJUnitXml(await Deno.readTextFile(path));
      junit = junit
        ? {
          tests: junit.tests + parsed.tests,
          failures: junit.failures + parsed.failures,
          errors: junit.errors + parsed.errors,
          skipped: junit.skipped + parsed.skipped,
          durationMs: round(junit.durationMs + parsed.durationMs),
          files: [...(junit.files ?? []), ...(parsed.files ?? [])],
        }
        : parsed;
    } catch {
      // 单个 JUnit 缺失不影响计时报告。
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    manifests,
    timings: aggregateTimings(timing.records),
    junit,
    dataQuality: {
      jsonlFiles: timing.jsonlFiles,
      invalidLines: timing.invalidLines,
      invalidFiles: timing.invalidFiles,
      missingManifest: manifests.length === 0,
    },
  };
}

function ms(value: number): string {
  return `${Math.round(value)}ms`;
}

/** 渲染 Markdown；`top` 控制慢阶段/文件/用例的展示条数。 */
export function renderPerformanceMarkdown(
  report: PerformanceReport,
  options: RenderOptions = {},
): string {
  const top = options.top ?? 15;
  const lines: string[] = [];
  lines.push(`# ${options.title ?? "测试性能报告"}`, "");
  lines.push(`生成时间：${report.generatedAt}`, "");

  lines.push("## 运行清单", "");
  if (report.manifests.length === 0) {
    lines.push(
      "未找到 manifest.json；只能提供计时聚合，无法归因并发度与选中集合。",
      "",
    );
  } else {
    lines.push(
      "| suite | runId | command | commit | deno | jobs | shards | exit | duration |",
      "|---|---|---|---|---|---|---|---|---|",
    );
    for (const manifest of report.manifests) {
      lines.push(
        `| ${manifest.suite ?? "-"} | ${manifest.runId ?? "-"} | ${
          (manifest.command ?? "-").replaceAll("|", "\\|")
        } | ${(manifest.commit ?? "-").slice(0, 8)} | ${
          manifest.denoVersion ?? "-"
        } | ${manifest.concurrency?.jobs ?? "-"} | ${
          manifest.concurrency?.shards ?? "-"
        } | ${manifest.exitCode ?? "-"} | ${
          manifest.durationMs === undefined ? "-" : ms(manifest.durationMs)
        } |`,
      );
    }
    lines.push("");
    const selected = report.manifests.flatMap((manifest) =>
      manifest.selected ?? []
    );
    const executed = report.manifests.flatMap((manifest) =>
      manifest.executed ?? []
    );
    if (selected.length || executed.length) {
      lines.push(
        `选中 ${new Set(selected).size} 个文件，实际执行 ${
          new Set(executed).size
        } 个文件。`,
        "",
      );
    }
  }

  if (report.junit) {
    const junit = report.junit;
    lines.push(
      "## JUnit",
      "",
      "| tests | failures | errors | skipped | 用时 |",
      "|---|---|---|---|---|",
      `| ${junit.tests} | ${junit.failures} | ${junit.errors} | ${junit.skipped} | ${
        ms(junit.durationMs)
      } |`,
      "",
    );
    if (junit.files && junit.files.length > 0) {
      lines.push("### JUnit 逐文件耗时", "");
      lines.push(
        "| 文件 | tests | failures | skipped | 用时 |",
        "|---|---|---|---|---|",
      );
      for (const file of junit.files.slice(0, top)) {
        lines.push(
          `| ${file.file} | ${file.tests} | ${file.failures} | ${file.skipped} | ${
            ms(file.durationMs)
          } |`,
        );
      }
      lines.push("");
    }
  }

  const timings = report.timings;
  lines.push(
    "## 汇总",
    "",
    "| 指标 | 值 |",
    "|---|---|",
    `| 计时记录 | ${timings.records} |`,
    `| 涉及文件 | ${timings.files} |`,
    `| 累计阶段耗时 | ${ms(timings.totalMs)} |`,
    `| 失败阶段 | ${timings.failures} |`,
    `| JSONL 文件 | ${report.dataQuality.jsonlFiles} |`,
    "",
  );

  lines.push("## 阶段耗时（按累计降序）", "");
  if (timings.phases.length === 0) {
    lines.push("暂无计时记录。", "");
  } else {
    lines.push(
      "| 阶段 | 次数 | 总计 | 中位数 | P95 | 最大 | 失败 |",
      "|---|---|---|---|---|---|---|",
    );
    for (const phase of timings.phases.slice(0, top)) {
      lines.push(
        `| ${phase.phase} | ${phase.count} | ${ms(phase.totalMs)} | ${
          ms(phase.medianMs)
        } | ${ms(phase.p95Ms)} | ${ms(phase.maxMs)} | ${phase.failures} |`,
      );
    }
    lines.push("");
  }

  lines.push("## 最慢文件", "");
  if (timings.fileStats.length === 0) lines.push("暂无文件级记录。", "");
  else {
    lines.push("| 文件 | 记录 | 累计 | 最大单次 |", "|---|---|---|---|");
    for (const file of timings.fileStats.slice(0, top)) {
      lines.push(
        `| ${file.file} | ${file.records} | ${ms(file.totalMs)} | ${
          ms(file.maxMs)
        } |`,
      );
    }
    lines.push("");
  }

  lines.push("## 最慢用例", "");
  if (timings.caseStats.length === 0) lines.push("暂无用例级记录。", "");
  else {
    lines.push(
      "| 用例 | 文件 | 次数 | 累计 | 最大单次 |",
      "|---|---|---|---|---|",
    );
    for (const item of timings.caseStats.slice(0, top)) {
      lines.push(
        `| ${item.caseName} | ${item.file ?? "-"} | ${item.records} | ${
          ms(item.totalMs)
        } | ${ms(item.maxMs)} |`,
      );
    }
    lines.push("");
  }

  const counts = timings.phases.filter((phase) =>
    phase.count > 0 &&
    phase.totalMs === 0
  );
  if (counts.length > 0) {
    lines.push("## 计数阶段", "");
    lines.push("| 阶段 | 次数 |", "|---|---|");
    for (const phase of counts) {
      lines.push(`| ${phase.phase} | ${phase.count} |`);
    }
    lines.push("");
  }

  lines.push("## 数据质量", "");
  lines.push(
    `- 坏行：${report.dataQuality.invalidLines}`,
    `- 坏文件：${report.dataQuality.invalidFiles.length}`,
    `- 缺少 manifest：${report.dataQuality.missingManifest ? "是" : "否"}`,
    "",
  );
  return lines.join("\n") + "\n";
}

function changeText(before: number, after: number): string {
  if (before === 0) return after === 0 ? "0%" : "-";
  const percent = ((after - before) / before) * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

/**
 * 比较两份报告。
 *
 * 同时给出 JUnit 测试数、执行文件数、记录数与每条记录平均耗时：只变快不等于
 * 测试变少，反之亦然。
 */
export function compareReports(
  before: PerformanceReport,
  after: PerformanceReport,
): ComparisonRow[] {
  const beforeTests = before.junit?.tests ?? 0;
  const afterTests = after.junit?.tests ?? 0;
  const beforeAvg = before.timings.records === 0
    ? 0
    : before.timings.totalMs / before.timings.records;
  const afterAvg = after.timings.records === 0
    ? 0
    : after.timings.totalMs / after.timings.records;
  const filesBefore =
    before.manifests.flatMap((manifest) => manifest.executed ?? []).length;
  const filesAfter =
    after.manifests.flatMap((manifest) => manifest.executed ?? []).length;
  const rows: Array<[string, number, number]> = [
    ["JUnit tests", beforeTests, afterTests],
    ["执行文件数", filesBefore, filesAfter],
    ["计时记录数", before.timings.records, after.timings.records],
    ["累计阶段耗时(ms)", before.timings.totalMs, after.timings.totalMs],
    ["每条记录平均(ms)", round(beforeAvg), round(afterAvg)],
  ];
  return rows.map(([metric, beforeValue, afterValue]) => ({
    metric,
    before: beforeValue,
    after: afterValue,
    change: changeText(beforeValue, afterValue),
  }));
}

if (import.meta.main) {
  const args = Deno.args;
  const timingDir = args[0];
  if (!timingDir) {
    console.error(
      "用法：deno run -A scripts/test-performance-report.ts <timingDir> [output.md]",
    );
    Deno.exit(2);
  }
  const report = await buildReport({ timingDir });
  const markdown = renderPerformanceMarkdown(report);
  const output = args[1] ?? `${timingDir.replace(/\/+$/, "")}/report.md`;
  await Deno.writeTextFile(output, markdown);
  console.log(markdown);
  console.log(`报告已写入 ${output}`);
}
