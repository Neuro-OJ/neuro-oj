/**
 * 慢测试基线：记录代表性测试命令耗时，供性能优化前后对比。
 *
 * 两种用法：
 * 1. `deno task test:baseline --suite <core|browser|api> --repeat 3`
 *    —— 通过统一启动器运行，读取 test-results/performance 下的阶段计时与 JUnit；
 * 2. `--suite legacy` —— 保留旧的 smoke 基线（core smoke / ui / gateway / judge）。
 *
 * 命令失败时**不中断**：失败本身必须出现在报告里（退出码、阶段计时、JUnit），
 * 全部跑完后再以非零码退出，否则"失败很快"会被误记成"优化有效"。
 */
import {
  buildReport,
  compareReports,
  type PerformanceReport,
  renderPerformanceMarkdown,
} from "./test-performance-report.ts";

export interface BaselineRow {
  module: string;
  command: string;
  durationMs: number;
}

export type BaselineSuite = "core" | "browser" | "api" | "legacy";

/** 统一启动器的 suite → 命令映射；`--profile` 由启动器转成 NOJ_TEST_PROFILE。 */
export const SUITE_COMMANDS: Record<
  Exclude<BaselineSuite, "legacy">,
  { cwd: string; command: string[] }
> = {
  core: {
    cwd: "noj-core",
    command: [
      "deno",
      "task",
      "test:parallel",
      "--shards",
      "4",
      "--jobs",
      "2",
      "--profile",
    ],
  },
  browser: {
    cwd: "noj-tests",
    command: ["deno", "task", "test:browser", "--profile"],
  },
  api: {
    cwd: "noj-tests",
    command: ["deno", "task", "test:api", "--profile"],
  },
};

/** `deno task test:baseline` 的参数。 */
export interface BaselineOptions {
  suite: BaselineSuite;
  repeat: number;
  output: string;
  jsonOutput?: string;
}

export interface SuiteRunResult {
  index: number;
  exitCode: number;
  durationMs: number;
  timingDir: string;
  report: PerformanceReport;
}

export interface SuiteSummary {
  suite: BaselineSuite;
  repeat: number;
  command: string;
  cwd: string;
  metadata: string;
  runs: SuiteRunResult[];
  medianMs: number;
  minMs: number;
  maxMs: number;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 60) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${s}s`;
}

export function renderBaseline(rows: BaselineRow[]): string {
  const lines = [
    "# 测试耗时基线",
    "",
    "| 模块 | 命令 | 耗时 |",
    "|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.module} | ${r.command} | ${formatDuration(r.durationMs)} |`,
    );
  }
  return lines.join("\n") + "\n";
}

/** 解析参数；未知 suite/repeat 直接失败，避免默默跑错套件。 */
export function parseBaselineArgs(args: string[]): BaselineOptions {
  const options: BaselineOptions = {
    suite: "core",
    repeat: 1,
    // 默认写到仓库根：任务可在任意模块目录执行，不能把报告散落到模块目录。
    output: `${REPO_ROOT}/dev-docs/engineering/test-performance-baseline.md`,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--suite") {
      const value = args[++i];
      if (!value || !["core", "browser", "api", "legacy"].includes(value)) {
        throw new Error(
          `--suite 只支持 core/browser/api/legacy，实际 "${value}"`,
        );
      }
      options.suite = value as BaselineSuite;
      continue;
    }
    if (arg === "--repeat") {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--repeat 必须是 ≥1 的整数");
      }
      options.repeat = value;
      continue;
    }
    if (arg === "--output") {
      const value = args[++i];
      if (!value) throw new Error("--output 缺少路径");
      options.output = value;
      continue;
    }
    if (arg === "--json") {
      const value = args[++i];
      if (!value) throw new Error("--json 缺少路径");
      options.jsonOutput = value;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return options;
}

/** 中位数/最小/最大；用于重复测量的收敛判断。 */
export function summarizeDurations(
  durations: number[],
): { medianMs: number; minMs: number; maxMs: number } {
  if (durations.length === 0) return { medianMs: 0, minMs: 0, maxMs: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
  return {
    medianMs: Math.round(median),
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
  };
}

async function gitCommit(cwd: string): Promise<string | undefined> {
  try {
    const result = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      cwd,
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(result.stdout).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** 仓库根：任务可以从任意工作目录调用，suite 的 cwd 永远相对仓库根解析。 */
const REPO_ROOT = decodeURIComponent(
  new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
);

async function runOnce(
  suite: Exclude<BaselineSuite, "legacy">,
  index: number,
  timingRoot: string,
): Promise<SuiteRunResult> {
  const { cwd, command } = SUITE_COMMANDS[suite];
  const timingDir = `${timingRoot}/run-${index}`;
  await Deno.mkdir(timingDir, { recursive: true });
  const env = {
    ...Deno.env.toObject(),
    NOJ_TEST_PROFILE: "1",
    NOJ_TEST_TIMING_DIR: timingDir,
    // 启动器要求 runId 只含字母/数字/下划线（用于数据库前缀），不能带连字符。
    NOJ_TEST_RUN_ID: `baseline_${Date.now()}_${index}`,
  };
  const start = performance.now();
  const result = await new Deno.Command(command[0]!, {
    args: command.slice(1),
    cwd: `${REPO_ROOT}/${cwd}`,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  const durationMs = performance.now() - start;
  const report = await buildReport({ timingDir });
  return {
    index,
    exitCode: result.code,
    durationMs: Math.round(durationMs),
    timingDir,
    report,
  };
}

async function measureLegacy(): Promise<BaselineRow[]> {
  const rows: BaselineRow[] = [];
  const commands: Array<{ module: string; cwd: string; command: string[] }> = [
    {
      module: "noj-core",
      cwd: "noj-core",
      command: ["deno", "task", "test:smoke"],
    },
    { module: "noj-ui", cwd: "noj-ui", command: ["deno", "task", "test"] },
    {
      module: "noj-llm-gateway",
      cwd: "noj-llm-gateway",
      command: ["deno", "task", "test"],
    },
    {
      module: "noj-judge",
      cwd: "noj-judge",
      command: ["cargo", "nextest", "run", "--all-targets"],
    },
  ];
  for (const item of commands) {
    const start = performance.now();
    const result = await new Deno.Command(item.command[0]!, {
      args: item.command.slice(1),
      cwd: `${REPO_ROOT}/${item.cwd}`,
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    const durationMs = performance.now() - start;
    if (result.code !== 0) {
      throw new Error(
        `基线命令失败（exit ${result.code}）：${
          item.command.join(" ")
        }（cwd=${item.cwd}）`,
      );
    }
    rows.push({
      module: item.module,
      command: item.command.join(" "),
      durationMs,
    });
  }
  return rows;
}

/** 渲染 suite 基线：墙钟中位数 + 每次运行的阶段摘要 + 每轮计数对照。 */
export function renderSuiteBaseline(summary: SuiteSummary): string {
  const lines = [
    `# 测试性能基线（suite=${summary.suite}）`,
    "",
    `- 命令：\`${summary.command}\``,
    `- 工作目录：${summary.cwd}`,
    `- 重复次数：${summary.repeat}`,
    `- 墙钟中位数：${formatDuration(summary.medianMs)}（范围 ${
      formatDuration(summary.minMs)
    } – ${formatDuration(summary.maxMs)}）`,
    `- 计时配置：${summary.metadata}`,
    "",
    "| 运行 | 退出码 | 墙钟 | 计时记录 | 累计阶段耗时 | JUnit tests | skipped | failures |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const run of summary.runs) {
    const junit = run.report.junit;
    lines.push(
      `| #${run.index} | ${run.exitCode} | ${
        formatDuration(run.durationMs)
      } | ${run.report.timings.records} | ${run.report.timings.totalMs}ms | ${
        junit?.tests ?? "-"
      } | ${junit?.skipped ?? "-"} | ${junit?.failures ?? "-"} |`,
    );
  }
  lines.push("");

  const latest = summary.runs[summary.runs.length - 1];
  if (latest) {
    lines.push(
      "## 最近一轮阶段明细",
      "",
      renderPerformanceMarkdown(latest.report, { top: 20, title: "阶段明细" }),
    );
  }
  if (summary.runs.length > 1) {
    lines.push("## 首轮 vs 末轮", "");
    const rows = compareReports(
      summary.runs[0]!.report,
      summary.runs[summary.runs.length - 1]!.report,
    );
    lines.push("| 指标 | 首轮 | 末轮 | 变化 |", "|---|---|---|---|");
    for (const row of rows) {
      lines.push(
        `| ${row.metric} | ${row.before} | ${row.after} | ${row.change} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

export async function runBaseline(
  options: BaselineOptions,
): Promise<{ exitCode: number; markdown: string; summary?: SuiteSummary }> {
  if (options.suite === "legacy") {
    const rows = await measureLegacy();
    return { exitCode: 0, markdown: renderBaseline(rows) };
  }
  const commit = await gitCommit(REPO_ROOT);
  const timingRoot =
    `${REPO_ROOT}/test-results/performance/baseline-${options.suite}-${
      new Date().toISOString().replace(/[:.]/g, "-")
    }`;
  const runs: SuiteRunResult[] = [];
  for (let index = 1; index <= options.repeat; index++) {
    console.log(
      `[test-baseline] suite=${options.suite} run=${index}/${options.repeat}`,
    );
    runs.push(await runOnce(options.suite, index, timingRoot));
    console.log(
      `[test-baseline] run=${index} exit=${runs.at(-1)!.exitCode} timing=${
        runs.at(-1)!.timingDir
      }`,
    );
  }
  const durations = runs.map((run) => run.durationMs);
  const summary: SuiteSummary = {
    suite: options.suite,
    repeat: options.repeat,
    command: SUITE_COMMANDS[options.suite].command.join(" "),
    cwd: SUITE_COMMANDS[options.suite].cwd,
    metadata: [
      `commit=${commit ?? "unknown"}`,
      `deno=${Deno.version.deno}`,
      `os=${Deno.build.os}/${Deno.build.arch}`,
      `ci=${Deno.env.get("CI") === "true"}`,
      "profile=1",
    ].join(" "),
    runs,
    ...summarizeDurations(durations),
  };
  const exitCode = runs.some((run) => run.exitCode !== 0) ? 1 : 0;
  return { exitCode, markdown: renderSuiteBaseline(summary), summary };
}

if (import.meta.main) {
  const options = parseBaselineArgs(Deno.args);
  const result = await runBaseline(options);
  await Deno.writeTextFile(options.output, result.markdown);
  if (options.jsonOutput && result.summary) {
    await Deno.writeTextFile(
      options.jsonOutput,
      JSON.stringify(result.summary, null, 2) + "\n",
    );
  }
  console.log(result.markdown);
  console.log(`基线已写入 ${options.output}`);
  Deno.exit(result.exitCode);
}
