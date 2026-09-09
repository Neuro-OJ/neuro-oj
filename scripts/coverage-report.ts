// 覆盖率报告入口。
// --report：聚合各模块覆盖率并写入 dev-docs/engineering/test-coverage.md。
// --check ：在报告基础上让模块自带的 `deno coverage --threshold` 门禁生效
//           （任一模块退出码非零即整体失败）。
import { run } from "./gate-runner.ts";

/** 单个模块的覆盖率（`deno coverage` 表格为百分比，无 covered/total 计数）。 */
export interface CoverageSummary {
  module: string;
  branch_percent: number;
  function_percent: number;
  line_percent: number;
}

/**
 * 解析 `deno coverage` 表格中的一行。
 *
 * 真实输出形如：
 * ```text
 * | File      | Branch % | Function % | Line % |
 * | m.ts      |    100.0 |      100.0 |  100.0 |
 * ```
 * 表头、分隔行与无法解析的行返回 null。
 */
export function parseCoverageLine(line: string): CoverageSummary | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const body = trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed.slice(1);
  const cells = body.split("|").map((cell) => cell.trim());
  if (cells.length < 4) return null;
  const [name, ...rest] = cells;
  if (!name || name === "File" || /^-+$/.test(name)) return null;
  const numbers = rest.slice(0, 3).map((cell) =>
    Number(cell.replace(/%$/, ""))
  );
  if (numbers.some((n) => Number.isNaN(n))) return null;
  return {
    module: name,
    branch_percent: numbers[0],
    function_percent: numbers[1],
    line_percent: numbers[2],
  };
}

/**
 * 从模块覆盖率输出中提取总体覆盖率。
 *
 * `deno coverage <dir>` 只输出逐文件表格、没有合计行，因此：
 * - 若存在 `All files` 行则直接采用；
 * - 否则对各文件的百分比取平均（报告口径为「文件平均覆盖率」）。
 */
export function summarizeModule(
  module: string,
  output: string,
): CoverageSummary | null {
  const rows: CoverageSummary[] = [];
  for (const line of output.split("\n")) {
    const parsed = parseCoverageLine(line);
    if (parsed) rows.push(parsed);
  }
  if (rows.length === 0) return null;
  const total = rows.find((row) => row.module === "All files");
  if (total) return { ...total, module };
  const average = (key: keyof CoverageSummary): number =>
    rows.reduce((sum, row) => sum + (row[key] as number), 0) / rows.length;
  return {
    module,
    branch_percent: average("branch_percent"),
    function_percent: average("function_percent"),
    line_percent: average("line_percent"),
  };
}

export function renderMarkdown(rows: CoverageSummary[]): string {
  const lines = [
    "# 测试覆盖率报告",
    "",
    "> 数据来源：`deno task test:coverage`（`deno coverage` 表格，百分比口径）。",
    "> noj-core / noj-judge 的覆盖率由各自 CI job 采集，不在本报告聚合范围内。",
    "",
    "| 模块 | 行 | 分支 | 函数 |",
    "|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.module} | ${r.line_percent.toFixed(1)}% | ` +
        `${r.branch_percent.toFixed(1)}% | ${r.function_percent.toFixed(1)}% |`,
    );
  }
  return lines.join("\n") + "\n";
}

/** 运行命令并捕获 stdout/stderr 与退出码。 */
async function runCapture(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const [cmd, ...rest] = args;
  const command = new Deno.Command(cmd, {
    args: rest,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    code: result.code,
  };
}

/** 需要聚合覆盖率的模块（各自 deno.json 定义了 test:coverage 任务与阈值）。 */
const COVERAGE_MODULES = [
  ["noj-ui", "noj-ui"],
  ["noj-llm-gateway", "noj-llm-gateway"],
] as const;

interface ModuleResult {
  summary: CoverageSummary | null;
  code: number;
  module: string;
}

async function collectModules(): Promise<ModuleResult[]> {
  const results: ModuleResult[] = [];
  for (const [module, dir] of COVERAGE_MODULES) {
    const result = await runCapture(["deno", "task", "test:coverage"], dir);
    const summary = summarizeModule(
      module,
      `${result.stdout}\n${result.stderr}`,
    );
    if (summary === null) {
      console.error(
        `⚠ ${module} 未解析到覆盖率数据（exit ${result.code}），请检查 test:coverage 任务输出`,
      );
    }
    results.push({ module, summary, code: result.code });
  }
  return results;
}

if (import.meta.main) {
  const results = await collectModules();
  const rows = results
    .map((r) => r.summary)
    .filter((r): r is CoverageSummary => r !== null);
  const md = renderMarkdown(rows);
  if (Deno.args.includes("--report")) {
    await Deno.writeTextFile("dev-docs/engineering/test-coverage.md", md);
    console.log("覆盖率报告已写入 dev-docs/engineering/test-coverage.md");
  } else {
    console.log(md);
  }
  if (Deno.args.includes("--check")) {
    const failed = results.filter((r) => r.code !== 0);
    if (failed.length > 0) {
      console.error(
        `覆盖率门禁失败：${
          failed.map((r) => r.module).join(", ")
        } 未达到阈值或测试失败`,
      );
      Deno.exit(1);
    }
  }
  // 保留 gate-runner 引用（check-all 等仍依赖其副作用，避免未使用告警）
  void run;
}
