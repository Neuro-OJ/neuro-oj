/** 演练收尾：报告与指标落盘、失败清理与演练栈拆除。 */

import { join } from "@std/path";
import { type CommandRunner } from "../../runtime/command.ts";
import { drillCleanupArgs } from "./plan.ts";
import {
  type ChecksInput,
  DRILL_METRICS_FILE,
  metricsDirOf,
  renderChecks,
  renderDrillMetrics,
  renderFailureReport,
  renderReport,
} from "./report.ts";
import { isFile } from "../../util/fs.ts";
import { type DrillRunOptions, type DrillRunResult } from "./drill.ts";
import { dockerBinOf, type DrillContext } from "./stack.ts";

/** 写报告（权限 600）与指标目录准备。 */
export async function writeReport(
  ctx: DrillContext,
  input:
    & Omit<
      Parameters<typeof renderReport>[0],
      "snapshot" | "composeProject" | "networkSubnet" | "checks" | "cleanup"
    >
    & { cleanup: "kept-for-review" | "done" },
  checks: ChecksInput,
): Promise<void> {
  const text = renderReport({
    ...input,
    snapshot: ctx.snapshot,
    composeProject: ctx.projectName,
    networkSubnet: ctx.subnet,
    checks: renderChecks(checks),
  });
  await writePrivate(ctx.reportPath, text);
}

/** 写演练指标（仅成功路径调用）。 */
export async function writeMetrics(
  opts: DrillRunOptions,
  ctx: DrillContext,
  at: Date,
): Promise<void> {
  const dir = metricsDirOf(ctx.snapshot, opts.metricsDir);
  await Deno.mkdir(dir, { recursive: true, mode: 0o755 });
  const file = join(dir, DRILL_METRICS_FILE);
  await Deno.writeTextFile(
    file,
    renderDrillMetrics(Math.floor(at.getTime() / 1000)),
  );
  await Deno.chmod(file, 0o644);
}

/** 原子写一个 600 文件（报告含内部 URL 与题目 ID，不应全局可读）。 */
async function writePrivate(path: string, text: string): Promise<void> {
  const tmp = `${path}.${Deno.pid}.${crypto.randomUUID()}.tmp`;
  await Deno.mkdir(path.substring(0, path.lastIndexOf("/")), {
    recursive: true,
  }).catch(() => {});
  const file = await Deno.open(tmp, {
    create: true,
    write: true,
    truncate: true,
    mode: 0o600,
  });
  try {
    await file.write(new TextEncoder().encode(text));
  } finally {
    file.close();
  }
  await Deno.chmod(tmp, 0o600);
  await Deno.rename(tmp, path);
}

/**
 * 失败路径：写失败报告 → 清理资源 → 返回退出码 1。
 *
 * **清理失败不掩盖原始错误**：原始失败原因（`message`）是诊断核心，清理问题
 * 只作为附加信息追加到 message 尾部，且不影响退出码（仍是 1）。
 */
export async function failAndCleanup(
  opts: DrillRunOptions,
  ctx: DrillContext,
  runner: CommandRunner,
  keep: boolean,
  stage: string,
  message: string,
  startedAt: string,
  log: (line: string) => void,
  verifyLog = "",
): Promise<DrillRunResult> {
  const cleanup: "kept-for-review" | "done" = keep ? "kept-for-review" : "done";
  let reportError: string | null = null;

  // 1) 先写失败报告（需要读验收日志，故在清理之前）
  if (stage !== "preflight") {
    try {
      await writePrivate(
        ctx.reportPath,
        renderFailureReport({
          snapshot: ctx.snapshot,
          failedStage: stage,
          drillStartedAt: startedAt,
          composeProject: ctx.projectName,
          verifyLogTail: tailLines(verifyLog, 50),
          cleanup,
        }),
      );
      log(`! 演练在 ${stage} 阶段失败，报告：${ctx.reportPath}`);
    } catch (err) {
      reportError = (err as Error).message;
    }
  }

  // 2) 清理资源（--keep 时保留）
  const cleanupErrors: string[] = [];
  if (reportError !== null) cleanupErrors.push(`写报告失败：${reportError}`);
  if (!keep) {
    const code = await downDrillStack(ctx, runner, dockerBinOf(opts));
    if (code !== 0) {
      cleanupErrors.push(`清理演练 Compose 资源失败（退出码 ${code}）`);
    }
    try {
      await Deno.remove(ctx.drillDir, { recursive: true });
    } catch (err) {
      cleanupErrors.push(`删除演练目录失败：${(err as Error).message}`);
    }
  }

  return {
    pass: false,
    exitCode: 1,
    reportPath: ctx.reportPath,
    failedStage: stage,
    checks: null,
    message: cleanupErrors.length === 0
      ? message
      : `${message}（另有：${cleanupErrors.join("；")}）`,
  };
}

/** 清理演练 Compose 资源（`down -v --remove-orphans`）。 */
export async function downDrillStack(
  ctx: DrillContext,
  runner: CommandRunner,
  dockerBin: string,
): Promise<number> {
  const overrideExists = await isFile(ctx.overrideFile);
  const res = await runner.run(
    dockerBin,
    drillCleanupArgs({
      projectName: ctx.projectName,
      composeEnvFile: ctx.composeEnvFile,
      composeFile: ctx.composeFile,
      overrideFile: overrideExists ? ctx.overrideFile : undefined,
    }),
  );
  return res.code;
}

/** 清理解包暂存（前置失败路径用；演练目录由 cleanup 逻辑统一处理）。 */
export async function cleanupStaging(
  dir: string,
  keep: boolean,
): Promise<void> {
  if (keep) return;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

/** 读文本，失败返回兜底值。 */
export async function readTextOr(
  path: string,
  fallback: string,
): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return fallback;
  }
}

/** 取文本末尾 N 行。 */
export function tailLines(text: string, n: number): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}
