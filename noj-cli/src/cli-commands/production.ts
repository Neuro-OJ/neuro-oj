// 生产命令分发：安装目录定位、install/check/status/… 原生实现分派、backup/judge 子命令与 drill。

import { join, resolve } from "@std/path";
import { findProductionDir, ProductionDirError } from "../production.ts";
import {
  judgeCheck,
  judgeInstall,
  judgeInstallEnv,
  judgeLogs,
  judgeStart,
  judgeStatus,
  judgeStop,
  judgeUpgrade,
} from "../prod/judge/actions.ts";
import {
  envNumber,
  flagValue,
  hasFlag,
  hasJson,
  numberFlag,
  parseProdArgs,
  positionals,
  rejectUnimplementedProdFlags,
  runBackupCreate,
  runBackupList,
  runBackupPrune,
  runBackupRestore,
  runBackupSchedule,
  runBackupVerify,
  runProdCheck,
  runProdInstall,
  runProdLogs,
  runProdRestart,
  runProdStart,
  runProdStatus,
  runProdStop,
  runProdUninstall,
  runProdUpdate,
  runProdVerify,
} from "../prod/cli.ts";
import { UsageError } from "../util/args.ts";
import { runDrill } from "../prod/drill/drill.ts";
import { readEnvValues } from "../prod/drill/plan.ts";
import { createLocalRedis } from "../prod/judge/config.ts";
import { PROD_ENV_FILE } from "../prod/compose.ts";
import { realRunner } from "../runtime/command.ts";
import { type BackupArgs, parseBackupArgs } from "../backup-args.ts";
import type { CommandContext } from "./context.ts";
import { formatBytes } from "./args.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, wantsHelp } from "./guards.ts";
import { renderDrillHelp } from "./help.ts";

/**
 * `backup drill`：解析参数并执行**真实恢复演练**。
 *
 * **T24 接线**：目录由调用方（`dispatchProduction`）给定——它已用
 * `findProductionDir` 定位过，这里不再重复探测（重复探测会在"显式 --dir 与实际
 * 安装目录不一致"时给出误导性的第二次报错）。
 */
export async function runBackupDrillFromProduction(
  args: string[],
  ctx: { cwd: string; prodDir: string },
): Promise<number> {
  void ctx;
  if (wantsHelp(args)) {
    console.log(renderDrillHelp());
    return EXIT_OK;
  }
  const a = parseBackupArgs(["drill", ...args]);
  if (a.snapshot === undefined) {
    console.error(
      "backup drill: 需要 <snapshot> 路径" + "\n" +
        "  提示：drill 会起独立 Compose 项目做真实恢复（分钟级、需 Docker）；" +
        "只校验文件完整请用 backup verify。",
    );
    return EXIT_USAGE;
  }
  return await executeDrill(a, ctx.prodDir);
}

/**
 * 执行一次真实恢复演练并输出结果。
 *
 * **T23 接线**：改用 T19 的**原生**实现（`prod/drill/drill.ts`），不再经
 * `maintain/drill.ts` 的 bash 薄包装。这正是 R1 的落点——drill 路径因此
 * 零 `Deno.command("bash", …)`、零仓库脚本依赖。
 *
 * 退出码（#516 验收，T19 已实现并测试）：0 通过 / 1 演练失败（含 RPO/RTO 超标）/
 * 2 参数或资源错误。`runDrill` 内部已按此分层，这里只做输出与透传。
 */
export async function executeDrill(
  a: BackupArgs,
  dir: string,
): Promise<number> {
  try {
    const dockerHost = a.dockerHost ?? Deno.env.get("NOJ_DRILL_DOCKER_HOST");
    if (dockerHost === undefined || dockerHost.trim() === "") {
      console.error(
        "backup drill: 必须提供 --docker-host 或 NOJ_DRILL_DOCKER_HOST（专用隔离 Docker daemon）",
      );
      return EXIT_USAGE;
    }
    const result = await runDrill({
      snapshotPath: a.snapshot!,
      dir,
      runner: realRunner(),
      // **`--passphrase-file` > `NOJ_BACKUP_PASSPHRASE_FILE` > `.env.prod`**
      // （评审发现）：此前只透传旗标，环境变量形同虚设——而报错文案却
      // 明示该变量可用。
      passphraseFile: await resolveBackupPassphraseForDir(
        a.passphraseFile,
        dir,
      ),
      skipJudge: a.skipJudge,
      subnet: a.subnet,
      projectName: a.projectName,
      dockerHost,
      report: a.report,
      rpoMaxHours: a.rpoMaxHours,
      rtoMaxMinutes: a.rtoMaxMinutes,
      // `backup create --no-encrypt` 的产物必须也能被演练（评审发现）：
      // 否则"不加密"这条受支持的路径无法做恢复验收。
      encrypted: !a.noEncrypt,
      // `NOJ_DEPLOY_DOCKER_BIN` 与非默认 docker 路径的宿主机（评审发现）：
      // restore/drill 此前把 docker 写死，只有 install/update/create 装配
      // 尊重该变量。
      dockerBin: Deno.env.get("NOJ_DEPLOY_DOCKER_BIN") ?? undefined,
      keep: a.keepFlag === true,
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

/**
 * 生产命令的原生分发（T24）。
 *
 * 职责分工：
 * - **本函数**：定位安装目录（`findProductionDir`）→ 拆 `--dir` → 分派到
 *   `prod/cli.ts` 的对应入口 → 打印人类结论、透传退出码；
 * - **`prod/`**：命令的全部语义（前置校验、compose 编排、状态机、输出通道）。
 *
 * 退出码：0 成功 / 1 运行失败 / 2 用法错误。
 * `--json` 时原生实现已把结果 JSON 写到 stdout，因此这里**不再打印结论**
 * （否则 stdout 会混入人类文字，破坏 T6 契约）。
 */
export async function dispatchProduction(
  ctx: CommandContext,
  command: string,
  args: string[],
): Promise<number> {
  // **先拒绝未实现的旗标**（在任何副作用之前）：`--dry-run` 在破坏性命令上
  // 被静默忽略会让"预演"真的执行（评审实测：`uninstall --all --yes --dry-run`
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
  let dir: string;
  try {
    // install 和独立 judge 允许首次安装时指定空目录。
    const allowsFreshDir = command === "install" || command === "judge";
    dir = allowsFreshDir && parsed.dir !== undefined
      ? resolve(ctx.cwd, parsed.dir)
      : await findProductionDir(parsed.dir, ctx.cwd);
  } catch (e) {
    throw new ProductionDirError((e as Error).message);
  }
  const rest = parsed.rest;
  const json = hasJson(rest);
  // 人类结论统一走 stderr 或 stdout：`--json` 时走 stderr，保证 stdout 干净。
  const say = (text: string): void => {
    if (text === "") return;
    if (json) console.error(text);
    else console.log(text);
  };

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
      case "update": {
        const r = await runProdUpdate(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "upgrade": {
        const r = await runProdUpdate(dir, rest, {}, true);
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
        // 安全控制报成功却从未运行（评审发现）。
        const r = await runProdVerify(dir, rest, {});
        say(r.message);
        return r.exitCode;
      }
      case "config": {
        // `config check` 是唯一支持的子命令（与 bash 的 `config-check` 等价）。
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
        return await dispatchProdBackup(dir, rest, json);
      }
      case "judge": {
        return await dispatchProdJudge(dir, rest, json);
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

/**
 * `judge` 的子命令分发（T21 的原生实现 + T26 补齐的 `install-env`）。
 *
 * **T26 补漏**：T21 交付了 `prod/judge/*`（36 个测试全过），但 `judge` 既未登记在
 * `PRODUCTION_COMMANDS`、也无本函数——该能力从 CLI **完全不可达**。本函数把它接通，
 * 并补上当时缺失的 `install-env`（依赖检查 + rootless 隔离指引）。
 */
export async function dispatchProdJudge(
  dir: string,
  args: string[],
  json: boolean,
): Promise<number> {
  const sub = args[0] ?? "";
  const rest = args.slice(1);
  const say = (text: string): void => {
    if (text === "") return;
    if (json) console.error(text);
    else console.log(text);
  };
  const base = {
    dir,
    runner: realRunner(),
    envFile: flagValue(rest, "--env-file"),
    composeFile: flagValue(rest, "--compose-file"),
    dockerBin: Deno.env.get("NOJ_DEPLOY_DOCKER_BIN") ?? undefined,
    // **必须转发 `--dry-run`**（评审发现）：`judgeInstall` 里有完整的 dry-run
    // 分支（校验后直接返回、不写任何文件），但 CLI 层从未传这个字段，于是
    // `--dry-run` 被静默吞掉 → **真的写了 `.env.judge`** 才因后续检查失败退出。
    // 即"预演"产生了副作用，违反 plan T21 §6 的"dry-run 零副作用"。
    dryRun: hasFlag(rest, "--dry-run"),
    log: say,
  };

  switch (sub) {
    case "install-env": {
      const r = await judgeInstallEnv(base);
      say(r.message);
      return r.exitCode;
    }
    case "install": {
      // `--redis-mode local`：先为本机 Judge 创建**仅绑定回环**的 Redis，
      // 再把它的连接串喂给 install（bash `create_local_redis` 的接线）。
      // 缺省（不传）为"连接已有 Redis"，与 bash 交互式缺省一致。
      let redisUrl = flagValue(rest, "--redis-url");
      let localRedis: Awaited<ReturnType<typeof createLocalRedis>> | null =
        null;
      const redisMode = flagValue(rest, "--redis-mode");
      // **`--dry-run` 下绝不创建 Redis**：bash 的 install 在 `DRY_RUN` 时早退
      // （judge-install.sh:523），根本走不到 `configure_redis`。
      // 我第一版把创建放在 dry-run 判断之前，实测 `--dry-run` 真的建了容器并写了
      // `redis.conf`——违反"预演零副作用"，而那正是本会话反复修过的一类缺陷。
      const dryRunForRedis = hasFlag(rest, "--dry-run");
      if (redisMode === "local" && dryRunForRedis) {
        say("[dry-run] 将创建本机 Redis（仅绑定 127.0.0.1，不执行）");
      } else if (redisMode === "local") {
        const portRaw = flagValue(rest, "--redis-port");
        localRedis = await createLocalRedis({
          dir,
          runner: base.runner,
          containerName: flagValue(rest, "--redis-container"),
          port: portRaw === undefined
            ? undefined
            : Number.parseInt(portRaw, 10),
          dockerBin: base.dockerBin,
        });
        redisUrl = localRedis.checkUrl;
        say(
          `✓ 本机 Redis 已就绪：${localRedis.containerName}（仅绑定 127.0.0.1:${localRedis.port}）`,
        );
      } else if (redisMode !== undefined && redisMode !== "existing") {
        throw new UsageError(
          `--redis-mode 只能是 local 或 existing，收到 "${redisMode}"`,
        );
      }
      const r = await judgeInstall({
        ...base,
        version: flagValue(rest, "--version"),
        redisUrl,
        // 容器内的 Judge 必须走 `host.docker.internal`（Redis 在宿主机上）
        redisCheckUrl: localRedis === null
          ? flagValue(rest, "--redis-url")
          : localRedis.runtimeUrl,
        socketPath: flagValue(rest, "--socket-path"),
        socketGid: flagValue(rest, "--socket-gid"),
        values: {},
      });
      say(r.message);
      return r.exitCode;
    }
    case "check": {
      const r = await judgeCheck(base);
      say(r.message);
      return r.exitCode;
    }
    case "start": {
      const r = await judgeStart(base);
      say(r.message);
      return r.exitCode;
    }
    case "stop": {
      const r = await judgeStop(base);
      say(r.message);
      return r.exitCode;
    }
    case "status": {
      const r = await judgeStatus(base);
      if (json) {
        console.log(JSON.stringify(
          {
            exitCode: r.exitCode,
            message: r.message,
            summary: r.summary,
            ps: r.psOutput,
          },
          null,
          2,
        ));
      } else {
        // **人类模式不得重复打印**（评审发现）：`judgeStatus` 已经通过
        // `base.log`（= say）逐行输出了 summary 与 compose ps，这里再打印
        // 一遍会让每行出现两次（实测 15 行重复）。
        // 因此人类模式只补 `message`；`summary`/`psOutput` 仅在 `--json`
        // 分支作为结构化字段输出（那时 log 走 stderr，不污染 stdout）。
        say(r.message);
      }
      return r.exitCode;
    }
    case "logs": {
      const r = await judgeLogs({
        ...base,
        follow: hasFlag(rest, "--follow", "-f"),
      });
      say(r.message);
      return r.exitCode;
    }
    case "upgrade": {
      // 版本来自配置文件（`prepareExisting` 会读取并校验），不接受 `--version`：
      // 升级的目标版本是"配置里写的那个"，显式传值会让配置与实际运行不一致。
      const r = await judgeUpgrade(base);
      say(r.message);
      return r.exitCode;
    }
    default:
      console.error(
        `judge 需要子命令 install-env/install/check/start/stop/status/logs/` +
          `upgrade，收到 "${sub}"`,
      );
      return EXIT_USAGE;
  }
}

/** `backup` 的子命令分发（T17–T20 的原生实现）。 */
export async function dispatchProdBackup(
  dir: string,
  args: string[],
  json: boolean,
): Promise<number> {
  // `drill` 需要自己的 help 文案（已在上方处理），这里只分派执行。
  const sub = args[0] ?? "";
  const rest = args.slice(1);
  const say = (text: string): void => {
    if (text === "") return;
    if (json) console.error(text);
    else console.log(text);
  };
  switch (sub) {
    case "drill":
      return await runBackupDrillFromProduction(rest, {
        cwd: Deno.cwd(),
        prodDir: dir,
      });
    case "create": {
      const created = await runBackupCreate(dir, {
        args: rest,
        deps: {},
        passphraseFile: flagValue(rest, "--passphrase-file"),
        backupDir: flagValue(rest, "--backup-dir"),
        zstdLevel: numberFlag(rest, "--zstd-level"),
        noEncrypt: hasFlag(rest, "--no-encrypt"),
        // 环境变量缺省与 bash 一致（`NOJ_BACKUP_RETENTION_DAYS` /
        // `NOJ_BACKUP_MIN_FREE_MB`，backup.sh:13-14）。
        retentionDays: numberFlag(rest, "--retention-days") ??
          envNumber("NOJ_BACKUP_RETENTION_DAYS"),
        minFreeMb: numberFlag(rest, "--min-free-mb") ??
          envNumber("NOJ_BACKUP_MIN_FREE_MB"),
      });
      if (json) {
        console.log(JSON.stringify(
          {
            path: created.path,
            sha256: created.sha256,
            sidecar: created.sidecar,
            payload_layout: created.manifest.payload_layout,
          },
          null,
          2,
        ));
      } else {
        say(`完整生产快照已创建：${created.path}`);
        say(`校验文件：${created.sidecar}`);
      }
      return EXIT_OK;
    }
    case "verify": {
      const r = await runBackupVerify(dir, rest, {});
      if (json) {
        console.log(JSON.stringify(
          {
            path: r.path,
            pass: r.pass,
            checks: r.checks,
            issues: r.issues,
          },
          null,
          2,
        ));
      } else {
        say(r.summary);
      }
      return r.pass ? EXIT_OK : EXIT_FAILURE;
    }
    case "list": {
      const r = await runBackupList(dir, rest, {});
      if (json) {
        console.log(JSON.stringify(r, null, 2));
      } else if (r.entries.length === 0) {
        say("没有可用备份");
      } else {
        for (const e of r.entries) {
          say(`${e.name}  ${formatBytes(e.bytes ?? 0)}  ${e.createdAt}`);
        }
      }
      return EXIT_OK;
    }
    case "prune": {
      const r = await runBackupPrune(dir, rest, {});
      if (json) {
        console.log(JSON.stringify(
          {
            applied: r.applied,
            deleted: r.deleted.map((p) => p),
            planned: r.plan.remove.map((e) => e.name),
            failed: r.failed.map((f) => f.path),
          },
          null,
          2,
        ));
      } else {
        // 默认 dry-run：必须明确告知"没有删任何东西"，否则用户以为已清理
        say(
          r.applied
            ? `已删除 ${r.deleted.length} 个备份`
            : `[dry-run] 将删除 ${r.plan.remove.length} 个备份（加 --confirm 才真正删除）`,
        );
        for (const e of r.plan.remove) say(`  - ${e.name}`);
      }
      return r.failed.length === 0 ? EXIT_OK : EXIT_FAILURE;
    }
    case "restore": {
      // `--confirm` → 真实恢复；否则 dry-run 计划（文档承诺的语义）。
      // `--dry-run` 是**显式**的 dry-run 请求：与 `--confirm` 互斥的检查
      // 已在 `dispatchProduction` 的开头完成（纯参数错误先于目录解析）。
      const r = await runBackupRestore(dir, rest, {});
      if (json) {
        console.log(JSON.stringify(r, null, 2));
      } else {
        say(r.summary);
        if (r.kind === "restored") {
          for (const component of r.restored) say(`  ✓ 已恢复：${component}`);
        }
      }
      if (r.kind === "dry-run") {
        return r.verified ? EXIT_OK : EXIT_FAILURE;
      }
      return EXIT_OK;
    }
    case "schedule": {
      const r = await runBackupSchedule(dir, rest, {});
      if (json) {
        console.log(JSON.stringify(
          {
            exitCode: r.exitCode,
            message: r.message,
            block: r.block,
          },
          null,
          2,
        ));
      } else {
        say(r.message);
      }
      return r.exitCode;
    }
    default:
      console.error(
        `backup 需要子命令 create/verify/list/prune/restore/drill/schedule，` +
          `收到 "${sub}"`,
      );
      return EXIT_USAGE;
  }
}
/**
 * 解析 drill 的口令文件（`--passphrase-file` > 进程环境 > `.env.prod`）。
 *
 * 独立成函数是因为 drill 的调用点只有 `executeDrill`，而它需要 `dir`
 * 才能读安装目录里的 `.env.prod`（评审发现：环境变量此前未接线）。
 */
export async function resolveBackupPassphraseForDir(
  flag: string | undefined,
  dir: string,
): Promise<string | undefined> {
  if (flag !== undefined && flag !== "") return flag;
  const fromEnv = Deno.env.get("NOJ_BACKUP_PASSPHRASE_FILE");
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    const configured = (await readEnvValues(join(dir, PROD_ENV_FILE)))[
      "NOJ_BACKUP_PASSPHRASE_FILE"
    ];
    return configured === "" ? undefined : configured;
  } catch {
    // 安装目录不可读不在此处致命：口令的必需性由 runDrill 自己的前置校验决定。
    return undefined;
  }
}
