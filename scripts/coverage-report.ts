// 覆盖率报告入口。
// --report：聚合各模块覆盖率并写入 dev-docs/engineering/test-coverage.md（不失败）。
// 默认：打印聚合报告，不因阈值退出非零（与“不设硬门禁”一致）。
import { run } from "./gate-runner.ts";

export interface CoverageSummary {
  module: string;
  percent: number;
  covered: number;
  total: number;
}

export function parseCoverageSummary(line: string): CoverageSummary {
  const m = line.match(/^\s*([\w-]+)\s+\|\s+([\d.]+)%\s+\|\s+(\d+)\/(\d+)/);
  if (!m) throw new Error(`无法解析覆盖率行: ${line}`);
  return {
    module: m[1],
    percent: Number(m[2]),
    covered: Number(m[3]),
    total: Number(m[4]),
  };
}

export function renderMarkdown(rows: CoverageSummary[]): string {
  const lines = [
    "# 测试覆盖率报告",
    "",
    "| 模块 | 覆盖率 | 覆盖/总数 |",
    "|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(`| ${r.module} | ${r.percent}% | ${r.covered}/${r.total} |`);
  }
  return lines.join("\n") + "\n";
}

/** 运行命令并捕获 stdout/stderr，不因退出码失败（报告模式）。 */
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

async function collectSummaries(): Promise<CoverageSummary[]> {
  const out: CoverageSummary[] = [];
  // noj-ui / noj-llm-gateway 使用 deno coverage 输出
  for (const [module, dir] of [
    ["noj-ui", "noj-ui"],
    ["noj-llm-gateway", "noj-llm-gateway"],
  ] as const) {
    const result = await runCapture(["deno", "task", "test:coverage"], dir);
    const text = `${result.stdout}\n${result.stderr}`;
    for (const line of text.split("\n")) {
      if (line.includes("%") && line.includes("/")) {
        try {
          out.push(parseCoverageSummary(line));
        } catch {
          // 忽略非汇总行
        }
      }
    }
  }
  // noj-core / noj-judge 暂以占位行输出（后续 Phase 1/3 接入真实数据）
  out.push({ module: "noj-core", percent: 0, covered: 0, total: 0 });
  out.push({ module: "noj-judge", percent: 0, covered: 0, total: 0 });
  return out;
}

if (import.meta.main) {
  const report = await collectSummaries();
  const md = renderMarkdown(report);
  if (Deno.args.includes("--report")) {
    await Deno.writeTextFile("dev-docs/engineering/test-coverage.md", md);
    console.log("覆盖率报告已写入 dev-docs/engineering/test-coverage.md");
  } else {
    console.log(md);
  }
  // 保留 gate-runner 引用，避免未使用告警（check-all 等仍依赖其副作用）
  void run;
}
