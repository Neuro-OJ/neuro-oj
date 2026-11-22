// 生产命令分发：安装目录定位 → 按命令分派到 `prod/commands/` → 打印人类结论、透传退出码。

import { resolve } from "@std/path";
import { findProductionDir } from "../prod/install-dir.ts";
import {
  hasJson,
  humanOutput,
  parseProdArgs,
  positionals,
  rejectUnimplementedProdFlags,
} from "../prod/commands/args.ts";
import { hasFlag } from "../util/args.ts";
import { runProdBackup } from "../prod/commands/backup.ts";
import { runProdCheck, runProdVerify } from "../prod/commands/check.ts";
import { runProdJudge } from "../prod/commands/judge.ts";
import {
  runProdInstall,
  runProdLogs,
  runProdRestart,
  runProdStart,
  runProdStatus,
  runProdStop,
  runProdUninstall,
} from "../prod/commands/lifecycle.ts";
import { runProdUpdate } from "../prod/commands/update.ts";
import { UsageError } from "../util/args.ts";
import type { CommandContext } from "./context.ts";
import { EXIT_FAILURE, EXIT_USAGE } from "./exit-codes.ts";

/**
 * 生产命令的原生分发。
 *
 * 职责分工：
 * - **本函数**：定位安装目录（`findProductionDir`）→ 拆 `--dir` → 分派到
 *   `prod/commands/` 的对应入口 → 打印人类结论、透传退出码；
 * - **`prod/`**：命令的全部语义（前置校验、compose 编排、状态机、输出通道）。
 *
 * 退出码：0 成功 / 1 运行失败 / 2 用法错误。
 * `--json` 时原生实现已把结果 JSON 写到 stdout，因此这里**不再打印结论**
 * （否则 stdout 会混入人类文字，破坏 JSON 输出契约）。
 */
export async function dispatchProduction(
  ctx: CommandContext,
  command: string,
  args: string[],
): Promise<number> {
  // **先拒绝未实现的旗标**（在任何副作用之前）：`--dry-run` 在破坏性命令上
  // 被静默忽略会让"预演"真的执行（`uninstall --all --yes --dry-run`
  // 删除了整个安装目录）。必须在解析/分发之前。
  // 已实现 `--dry-run` 的命令必须放行：`judge`（`judgeInstall` 内的 dry-run 分支）
  // 与 `backup restore`（`README.md` / CHANGELOG 承诺的"只规划并校验"）。
  const dryRunAllowed = command === "judge" ||
    (command === "backup" && args[0] === "restore");
  rejectUnimplementedProdFlags(args, dryRunAllowed ? ["--dry-run"] : []);
  // **互相矛盾的旗标在解析目录之前就拒绝**：`--dry-run`（只规划）与
  // `--confirm`（会真正覆盖数据）同时给出属用法错误——猜哪个都危险，
  // 且纯参数错误不该依赖"安装目录能否找到"。
  if (
    command === "backup" && args[0] === "restore" &&
    hasFlag(args, "--dry-run") && hasFlag(args, "--confirm")
  ) {
    throw new UsageError(
      "--dry-run 与 --confirm 不能同时使用：前者只规划、后者会真正覆盖数据",
    );
  }
  const parsed = parseProdArgs(args);
  // install 和独立 judge 允许首次安装时指定空目录。
  const allowsFreshDir = command === "install" || command === "judge";
  const dir = allowsFreshDir && parsed.dir !== undefined
    ? resolve(ctx.cwd, parsed.dir)
    : await findProductionDir(parsed.dir, ctx.cwd);
  const rest = parsed.rest;
  const json = hasJson(rest);
  // 人类结论：`--json` 时走 stderr，保证 stdout 干净。
  const say = humanOutput(json);
  // 人类结论统一走 stderr 或 stdout：`--json` 时走 stderr，保证 stdout 干净。

  try {
    switch (command) {
      case "install": {
        const r = await runProdInstall(dir, rest, {});
        say(r.message);
        return r.exitCode;
      }
      case "check": {
        const r = await runProdCheck(dir, rest, {});
        say(r.message);
        return r.exitCode;
      }
      case "status": {
        const r = await runProdStatus(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "start": {
        const r = await runProdStart(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "stop": {
        const r = await runProdStop(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "restart": {
        const r = await runProdRestart(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "logs": {
        const r = await runProdLogs(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "update":
      case "upgrade": {
        const r = await runProdUpdate(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "uninstall": {
        const r = await runProdUninstall(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "verify": {
        // `verify` = 配置校验 + **镜像验签**（比 `check` 多验签）。
        // 此前这里误调 `runProdCheck`，与 check/config 完全相同 →
        // 安全控制报成功却从未运行。
        const r = await runProdVerify(dir, rest, {});
        say(r.message);
        return r.exitCode;
      }
      case "config": {
        // `config check` 是唯一支持的子命令。
        const sub = positionals(rest)[0];
        if (sub !== undefined && sub !== "check") {
          console.error(`config 目前只支持 check，收到 "${sub}"`);
          return EXIT_USAGE;
        }
        const r = await runProdCheck(dir, rest, {});
        say(r.message);
        return r.exitCode;
      }
      case "backup": {
        return await runProdBackup(dir, rest, json);
      }
      case "judge": {
        return await runProdJudge(dir, rest, json);
      }
      default: {
        console.error(`未知生产命令：${command}`);
        return EXIT_USAGE;
      }
    }
  } catch (e) {
    // 参数错误 → 2；其余（原生实现抛出的运行失败）→ 1
    if (e instanceof UsageError) {
      console.error(`${command}: ${(e as Error).message}`);
      return EXIT_USAGE;
    }
    console.error(`${command}: ${(e as Error).message}`);
    return EXIT_FAILURE;
  }
}
