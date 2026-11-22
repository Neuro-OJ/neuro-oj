/** `backup drill` 子命令：参数解析与输出（演练语义见 `prod/drill/drill.ts`）。 */

import { realRunner } from "../../runtime/command.ts";
import { EXIT_USAGE } from "../../cli-commands/exit-codes.ts";
import { runDrill } from "../drill/drill.ts";
import { flagValue, hasFlag, UsageError } from "../../util/args.ts";
import { hasJson, positionals } from "./args.ts";
import { readConfiguredPassphrase, resolveBackupPassphrase } from "./deps.ts";

/** `backup drill` 的参数（`--dir` 已由 `dispatchProduction` 拆走）。 */
export interface DrillArgs {
  snapshot: string | undefined;
  dockerHost: string | undefined;
  skipJudge: boolean;
  subnet: string | undefined;
  projectName: string | undefined;
  report: string | undefined;
  rpoMaxHours: number | undefined;
  rtoMaxMinutes: number | undefined;
  noEncrypt: boolean;
  /** 裸 `--keep`：保留演练环境（与 prune 的 `--keep N` 不同，不带值）。 */
  keep: boolean;
  json: boolean;
}

/** 解析 drill 参数；非法值抛 {@link UsageError}。 */
export function parseDrillArgs(args: string[]): DrillArgs {
  return {
    // `positionals` 把 `--keep` 当带值旗标（prune 语义），drill 的裸 `--keep`
    // 须先剔除，否则会吞掉紧随其后的快照路径。
    snapshot: positionals(args.filter((a) => a !== "--keep"))[0],
    dockerHost: flagValue(args, "--docker-host"),
    skipJudge: hasFlag(args, "--skip-judge"),
    subnet: flagValue(args, "--subnet"),
    projectName: flagValue(args, "--project-name"),
    report: flagValue(args, "--report"),
    rpoMaxHours: positiveInt(args, "--rpo-max-hours"),
    rtoMaxMinutes: positiveInt(args, "--rto-max-minutes"),
    noEncrypt: hasFlag(args, "--no-encrypt"),
    keep: hasFlag(args, "--keep"),
    json: hasJson(args),
  };
}

function positiveInt(args: string[], name: string): number | undefined {
  const raw = flagValue(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`${name} 需要正整数，收到 "${raw}"`);
  }
  return n;
}

/**
 * `backup drill`：解析参数并执行一次真实恢复演练，输出结果。
 *
 * 目录由 `dispatchProduction` 定位后给定，这里不再重复探测。
 *
 * 实现见 `prod/drill/drill.ts`（零 bash / 仓库脚本依赖）。
 *
 * 退出码（#516）：0 通过 / 1 演练失败（含 RPO/RTO 超标）/
 * 2 参数或资源错误。`runDrill` 内部已按此分层，这里只做输出与透传。
 */
export async function runBackupDrill(
  dir: string,
  args: string[],
): Promise<number> {
  const a = parseDrillArgs(args);
  if (a.snapshot === undefined) {
    console.error(
      "backup drill: 需要 <snapshot> 路径" + "\n" +
        "  提示：drill 会起独立 Compose 项目做真实恢复（分钟级、需 Docker）；" +
        "只校验文件完整请用 backup verify。",
    );
    return EXIT_USAGE;
  }
  try {
    const dockerHost = a.dockerHost ?? Deno.env.get("NOJ_DRILL_DOCKER_HOST");
    if (dockerHost === undefined || dockerHost.trim() === "") {
      console.error(
        "backup drill: 必须提供 --docker-host 或 NOJ_DRILL_DOCKER_HOST（专用隔离 Docker daemon）",
      );
      return EXIT_USAGE;
    }
    const result = await runDrill({
      snapshotPath: a.snapshot,
      dir,
      runner: realRunner(),
      // 口令来源与其它 backup 子命令一致：旗标 > 进程环境 > `.env.prod`。
      passphraseFile: resolveBackupPassphrase(args, {
        env: Deno.env.toObject(),
        configured: await readConfiguredPassphrase(dir),
      }),
      skipJudge: a.skipJudge,
      subnet: a.subnet,
      projectName: a.projectName,
      dockerHost,
      report: a.report,
      rpoMaxHours: a.rpoMaxHours,
      rtoMaxMinutes: a.rtoMaxMinutes,
      // `backup create --no-encrypt` 的产物必须也能被演练：
      // 否则"不加密"这条受支持的路径无法做恢复验收。
      encrypted: !a.noEncrypt,
      // `NOJ_DEPLOY_DOCKER_BIN` 与非默认 docker 路径的宿主机：
      // restore/drill 此前把 docker 写死，只有 install/update/create 装配
      // 尊重该变量。
      dockerBin: Deno.env.get("NOJ_DEPLOY_DOCKER_BIN") ?? undefined,
      keep: a.keep,
      log: (line) => {
        // `--json` 时 stdout 必须逐字节为 JSON，故人类日志改道 stderr
        if (a.json) console.error(line);
        else console.log(line);
      },
    });
    if (a.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.message);
      if (result.reportPath) console.log("报告：" + result.reportPath);
    }
    return result.exitCode;
  } catch (e) {
    // 参数/资源错误 → 用法错误（2），与演练失败（1）区分
    console.error("backup drill: " + (e as Error).message);
    return EXIT_USAGE;
  }
}
