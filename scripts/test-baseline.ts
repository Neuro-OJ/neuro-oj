/**
 * 慢测试基线：记录各模块代表性测试命令耗时，供 Phase 5 加速对比。
 */
export interface BaselineRow {
  module: string;
  command: string;
  durationMs: number;
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

/**
 * 运行命令并返回耗时（毫秒）。
 *
 * 命令失败时抛错：失败的测试命令耗时没有意义，若直接记录会把「秒退的坏命令」
 * 记成「很快的基线」。
 */
async function measure(command: string[], cwd: string): Promise<number> {
  const [cmd, ...rest] = command;
  const start = performance.now();
  const proc = new Deno.Command(cmd, {
    args: rest,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const result = await proc.output();
  if (result.code !== 0) {
    throw new Error(
      `基线命令失败（exit ${result.code}）：${command.join(" ")}（cwd=${cwd}）`,
    );
  }
  return performance.now() - start;
}

if (import.meta.main) {
  const rows: BaselineRow[] = [];
  rows.push({
    module: "noj-core",
    command: "deno task test:smoke",
    durationMs: await measure(["deno", "task", "test:smoke"], "noj-core"),
  });
  rows.push({
    module: "noj-ui",
    command: "deno task test",
    durationMs: await measure(["deno", "task", "test"], "noj-ui"),
  });
  rows.push({
    module: "noj-llm-gateway",
    command: "deno task test",
    durationMs: await measure(["deno", "task", "test"], "noj-llm-gateway"),
  });
  rows.push({
    module: "noj-judge",
    command: "cargo nextest run --all-targets",
    durationMs: await measure(
      ["cargo", "nextest", "run", "--all-targets"],
      "noj-judge",
    ),
  });
  const md = renderBaseline(rows);
  await Deno.writeTextFile("dev-docs/engineering/test-baseline.md", md);
  console.log("测试耗时基线已写入 dev-docs/engineering/test-baseline.md");
}
