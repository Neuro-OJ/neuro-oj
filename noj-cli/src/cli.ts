import { findDeployDir } from "./util/find_deploy_dir.ts";
import { VERSION } from "./mod.ts";
import { realProbe } from "./doctor/probe.ts";
import { runDoctor } from "./doctor/doctor.ts";
import { formatReport } from "./doctor/report.ts";
import { realIO } from "./tui/io.ts";
import { type InitOptions, runInitWizard } from "./init/wizard.ts";
import { saveDeployment } from "./config/save.ts";
import { loadDeployment } from "./config/load.ts";
import {
  deployDown,
  deployRestart,
  deployStatus,
  deployUp,
} from "./deploy/deploy.ts";
import { maintainLogs, parseModulesArg } from "./maintain/logs.ts";
import {
  configCheck,
  configSet,
  configShow,
  maintainVerify,
} from "./maintain/config.ts";
import {
  backupCreate,
  backupDrill,
  backupRestore,
  backupVerify,
} from "./maintain/backup.ts";
import { maintainReset } from "./maintain/reset.ts";
import { realDriver } from "./maintain/backup_driver.ts";
import { runServerForeground } from "./runtime/process.ts";
import { PRODUCTION_COMMANDS, runProduction } from "./production.ts";
import { alertDrill } from "./observability/alert_drill.ts";
import { observabilityCheck } from "./observability/check.ts";
import { realHttp } from "./observability/http.ts";
import { runServerCommand } from "./server_cmd/server_cmd.ts";
import { resolveContext } from "./context/context.ts";
import { parseJudgeArgs } from "./judge/options.ts";
import { runJudgeCommand } from "./judge/commands.ts";

/** CLI 执行上下文，供各子命令共享。 */
export interface CommandContext {
  cwd: string;
  /** 向上查找到的部署目录，找不到为 null。 */
  deployDir: string | null;
}

/** 顶层命令分发。返回进程退出码。 */
export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (
    command === undefined || command === "--help" || command === "-h" ||
    command === "help"
  ) {
    console.log(printHelp());
    return 0;
  }

  const ctx: CommandContext = {
    cwd: Deno.cwd(),
    deployDir: findDeployDir(),
  };
  return await dispatchCommand(command, rest, ctx);
}

/** 生成帮助文本。 */
export function printHelp(): string {
  return [
    "noj-cli - Neuro OJ 统一部署与运维 CLI",
    "",
    "用法: noj-cli <命令> [子命令] [选项]",
    "",
    "命令:",
    "  install       生产安装（.env.prod + Docker Compose；以下命令支持 --dir）",
    "  check         生产环境检测",
    "  start/stop/restart/status  生产服务生命周期",
    "  update [--latest]  同步部署文件、备份并升级生产服务（upgrade 为别名）",
    "  logs          生产服务日志（支持 --follow）",
    "  backup        生产备份；支持 create/verify/restore/drill",
    "  verify        生产配置及镜像签名校验",
    "  config check  生产配置校验",
    "  uninstall     卸载生产服务；--all 删除全部数据，需确认",
    "",
    "JSON 配置部署工具（noj-deploy.json / noj-secrets.json）：",
    "  doctor        环境检测",
    "  deploy        部署生命周期 init/up/down/restart/status",
    "  maintain      运维 logs/config/verify/reset/backup(create/verify/restore/drill)",
    "  run-server    前台运行 noj-server 二进制",
    "  version       显示版本",
    "",
    "运维与观测命令：",
    "  observability check       检查 liveness/readiness/metrics（可选通知链路）",
    "  observability alert-drill 向 Alertmanager 注入告警并发送恢复事件",
    "  server <cmd>            容器内服务端管理命令（db/init/bootstrap/problems/dev-setup）",
    "  judge <cmd>            独立 Judge Worker 管理（install/install-env/check/start/stop/status/logs/upgrade/download）",
    "",
  ].join("\n");
}

const KNOWN_TOP = new Set([
  "doctor",
  "deploy",
  "maintain",
  "run-server",
  "version",
  "observability",
  "server",
  "judge",
]);

/** 解析 --port <n>，缺省 8080；非法值抛错。 */
export function parsePort(args: string[]): number {
  const idx = args.indexOf("--port");
  if (idx === -1) return 8080;
  const raw = args[idx + 1];
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`非法端口: ${raw}`);
  }
  return n;
}

/** 解析 deploy init 选项：--mode dev|prod、--port <n>、--dir <path>。 */
export function parseInitOptions(args: string[], cwd: string): InitOptions {
  let mode: "dev" | "prod" | undefined;
  let port: number | undefined;
  let dir: string | undefined;

  const modeIdx = args.indexOf("--mode");
  if (modeIdx !== -1) {
    const raw = args[modeIdx + 1];
    if (raw !== "dev" && raw !== "prod") {
      throw new Error(`非法模式: ${raw}，仅支持 dev/prod`);
    }
    mode = raw;
  }
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1) {
    const n = Number(args[portIdx + 1]);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`非法端口: ${args[portIdx + 1]}`);
    }
    port = n;
  }
  const dirIdx = args.indexOf("--dir");
  if (dirIdx !== -1) {
    dir = args[dirIdx + 1];
  }

  return { mode, port, installDir: dir ?? cwd };
}

/** 解析 deploy 生命周期参数：目前仅 --dir <path>。 */
export function parseDeployArgs(args: string[]): { dir: string | undefined } {
  const idx = args.indexOf("--dir");
  return { dir: idx !== -1 ? args[idx + 1] : undefined };
}

/** 解析 maintain 参数：--dir <path>、--follow、位置参数 modules。 */
export function parseMaintainArgs(args: string[]): {
  dir: string | undefined;
  follow: boolean;
  modules: string | undefined;
} {
  let dir: string | undefined;
  let follow = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dir") {
      dir = args[i + 1];
      i++;
    } else if (a === "--follow") {
      follow = true;
    } else {
      positional.push(a);
    }
  }
  return { dir, follow, modules: positional[0] };
}

/** maintain backup 参数解析结果。 */
export interface BackupArgs {
  sub: string;
  dir: string | undefined;
  backupDir: string | undefined;
  passphraseFile: string | undefined;
  zstdLevel: number;
  noEncrypt: boolean;
  confirm: boolean;
  includeDeployConfigs: boolean;
  snapshot: string | undefined;
  report: string | undefined;
}

/** 解析 maintain backup 参数：子命令 + 位置参数 snapshot + 各旗标。 */
export function parseBackupArgs(args: string[]): BackupArgs {
  const out: BackupArgs = {
    sub: args[0] ?? "",
    dir: undefined,
    backupDir: undefined,
    passphraseFile: undefined,
    zstdLevel: 15,
    noEncrypt: false,
    confirm: false,
    includeDeployConfigs: false,
    snapshot: undefined,
    report: undefined,
  };
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--dir":
        out.dir = args[++i];
        break;
      case "--backup-dir":
        out.backupDir = args[++i];
        break;
      case "--passphrase-file":
        out.passphraseFile = args[++i];
        break;
      case "--zstd-level":
        out.zstdLevel = Number(args[++i]);
        break;
      case "--no-encrypt":
        out.noEncrypt = true;
        break;
      case "--confirm":
        out.confirm = true;
        break;
      case "--include-deploy-configs":
        out.includeDeployConfigs = true;
        break;
      case "--report":
        out.report = args[++i];
        break;
      default:
        positional.push(args[i]!);
    }
  }
  out.snapshot = positional[0];
  return out;
}

/** observability 子命令参数解析结果。 */
export interface ObservabilityArgs {
  sub: string;
  baseUrl: string | undefined;
  checkNotifications: boolean;
  alertmanagerUrl: string | undefined;
  holdSeconds: number;
}

/** 解析 observability 参数：子命令 + base-url/check-notifications/alertmanager-url/hold。 */
export function parseObservabilityArgs(args: string[]): ObservabilityArgs {
  const out: ObservabilityArgs = {
    sub: args[0] ?? "",
    baseUrl: undefined,
    checkNotifications: false,
    alertmanagerUrl: undefined,
    holdSeconds: 300,
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--base-url": {
        const value = args[i + 1];
        if (value === undefined) throw new Error("--base-url 缺少值");
        out.baseUrl = value;
        i++;
        break;
      }
      case "--check-notifications":
        out.checkNotifications = true;
        break;
      case "--alertmanager-url": {
        const value = args[i + 1];
        if (value === undefined) throw new Error("--alertmanager-url 缺少值");
        out.alertmanagerUrl = value;
        i++;
        break;
      }
      case "--hold": {
        const value = args[i + 1];
        if (value === undefined) throw new Error("--hold 缺少值");
        if (!/^\d+$/.test(value)) {
          throw new Error(
            `非法 --hold: ${value}，需要非负整数`,
          );
        }
        out.holdSeconds = Number(value);
        i++;
        break;
      }
      default:
        throw new Error(`未知 observability 参数: ${a}`);
    }
  }
  return out;
}

/** server 顶层参数解析结果：仅剥离开头的全局 --dir；子命令内部 --dir 原样保留。 */
export interface ServerCliArgs {
  dir: string | undefined;
  args: string[];
}

/** 解析 server 顶层参数：支持 `server --dir <path> <子命令>`。 */
export function parseServerArgs(args: string[]): ServerCliArgs {
  if (args[0] !== "--dir") return { dir: undefined, args };
  if (args[1] === undefined) {
    throw new Error("server: --dir 缺少目录参数");
  }
  return { dir: args[1], args: args.slice(2) };
}

/** 将命令分发到对应处理函数。供测试与 run 共用。 */
export async function dispatchCommand(
  command: string,
  args: string[],
  ctx: CommandContext,
): Promise<number> {
  if (PRODUCTION_COMMANDS.has(command)) {
    return await runProduction(command, args);
  }
  switch (command) {
    case "version":
      console.log(`noj-cli ${VERSION}`);
      return 0;
    case "doctor": {
      const port = parsePort(args);
      const installDir = ctx.deployDir ?? ctx.cwd;
      const report = await runDoctor(realProbe(), { port, installDir });
      console.log(formatReport(report));
      return report.failed ? 1 : 0;
    }
    case "deploy": {
      const sub = args[0] ?? "";
      if (sub === "init") {
        const opts = parseInitOptions(args.slice(1), ctx.cwd);
        const { config, secrets } = await runInitWizard(
          realIO(),
          realProbe(),
          opts,
        );
        await saveDeployment(opts.installDir, config, secrets);
        console.log(
          `已写入 ${opts.installDir}/noj-deploy.json 与 noj-secrets.json`,
        );
        return 0;
      }
      const { dir } = parseDeployArgs(args.slice(1));
      const deployDir = dir ?? ctx.deployDir ?? findDeployDir(ctx.cwd);
      if (deployDir === null) {
        console.error("deploy: 未找到 noj-deploy.json，请先运行 deploy init");
        return 1;
      }
      switch (sub) {
        case "up": {
          const state = await deployUp({ dir: deployDir });
          console.log(`deploy up 完成，状态: ${state}`);
          return 0;
        }
        case "down": {
          const state = await deployDown({ dir: deployDir });
          console.log(`deploy down 完成，状态: ${state}`);
          return 0;
        }
        case "restart": {
          const state = await deployRestart({ dir: deployDir });
          console.log(`deploy restart 完成，状态: ${state}`);
          return 0;
        }
        case "status": {
          const report = await deployStatus({ dir: deployDir });
          console.log(`状态: ${report.state}`);
          for (const c of report.components) {
            console.log(
              `  ${c.component}: ${
                c.enabled ? (c.running ? "运行中" : "未运行") : "禁用"
              } (${c.method})`,
            );
          }
          return 0;
        }
        default:
          console.log("deploy: 需要子命令 init/up/down/restart/status");
          return 0;
      }
    }
    case "maintain": {
      const sub = args[0] ?? "";
      if (sub === "restore") {
        return await dispatchCommand("maintain", [
          "backup",
          "restore",
          ...args.slice(1),
        ], ctx);
      }
      if (sub === "logs") {
        const { dir, follow, modules } = parseMaintainArgs(args.slice(1));
        const deployDir = dir ?? ctx.deployDir ?? findDeployDir(ctx.cwd);
        if (deployDir === null) {
          console.error(
            "maintain logs: 未找到 noj-deploy.json，请先运行 deploy init",
          );
          return 1;
        }
        try {
          const { config } = await loadDeployment(deployDir);
          const mods = parseModulesArg(modules, config);
          await maintainLogs({ dir: deployDir, modules: mods, follow });
          return 0;
        } catch (e) {
          console.error(`maintain logs: ${(e as Error).message}`);
          return 1;
        }
      }
      if (sub === "config") {
        const rest = args.slice(1);
        let dirOverride: string | undefined;
        const positional: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--dir") {
            dirOverride = rest[++i];
          } else {
            positional.push(rest[i]!);
          }
        }
        const action = positional[0] ?? "";
        const deployDir = dirOverride ?? ctx.deployDir ??
          findDeployDir(ctx.cwd);
        if (deployDir === null) {
          console.error(
            "maintain config: 未找到 noj-deploy.json，请先运行 deploy init",
          );
          return 1;
        }
        try {
          switch (action) {
            case "check": {
              const issues = await configCheck(deployDir);
              if (issues.length === 0) {
                console.log("配置校验通过");
                return 0;
              }
              for (const i of issues) {
                console.error(`  ${i.path}: ${i.message}`);
              }
              return 1;
            }
            case "show": {
              console.log(await configShow(deployDir));
              return 0;
            }
            case "set": {
              const key = positional[1];
              const value = positional[2];
              if (key === undefined || value === undefined) {
                console.error("maintain config set: 需要 <key> <value>");
                return 1;
              }
              await configSet(deployDir, key, value);
              console.log(`已更新 ${key} = ${value}`);
              return 0;
            }
            default:
              console.log("maintain config: 需要子命令 check/show/set");
              return 0;
          }
        } catch (e) {
          console.error(`maintain config: ${(e as Error).message}`);
          return 1;
        }
      }
      if (sub === "backup") {
        const a = parseBackupArgs(args.slice(1));
        const deployDir = a.dir ?? ctx.deployDir ?? findDeployDir(ctx.cwd);
        if (deployDir === null) {
          console.error("maintain backup: 未找到 noj-deploy.json");
          return 1;
        }
        try {
          switch (a.sub) {
            case "create": {
              const r = await backupCreate({
                dir: deployDir,
                backupDir: a.backupDir,
                passphraseFile: a.passphraseFile,
                zstdLevel: a.zstdLevel,
                noEncrypt: a.noEncrypt,
                driver: realDriver(),
              });
              console.log(`备份完成: ${r.path}`);
              console.log(`SHA-256: ${r.sha256}`);
              return 0;
            }
            case "verify": {
              if (a.snapshot === undefined) {
                console.error("maintain backup verify: 需要 <snapshot> 路径");
                return 1;
              }
              const report = await backupVerify({
                snapshotPath: a.snapshot,
                passphraseFile: a.passphraseFile,
                driver: realDriver(),
              });
              if (report.pass) {
                console.log("校验通过");
                return 0;
              }
              for (const e of report.errors) console.error(`  ${e}`);
              return 1;
            }
            case "restore": {
              if (a.snapshot === undefined) {
                console.error("maintain backup restore: 需要 <snapshot> 路径");
                return 1;
              }
              const state = await backupRestore({
                dir: deployDir,
                snapshotPath: a.snapshot,
                confirm: a.confirm,
                passphraseFile: a.passphraseFile,
                includeDeployConfigs: a.includeDeployConfigs,
                driver: realDriver(),
              });
              console.log(`恢复完成，状态: ${state}`);
              return 0;
            }
            case "drill": {
              if (a.snapshot === undefined) {
                console.error("maintain backup drill: 需要 <snapshot> 路径");
                return 1;
              }
              const report = await backupDrill({
                snapshotPath: a.snapshot,
                passphraseFile: a.passphraseFile,
                report: a.report,
                driver: realDriver(),
              });
              console.log(
                `演练完成（drill）：${report.pass ? "通过" : "失败"}`,
              );
              return report.pass ? 0 : 1;
            }
            default:
              console.log(
                "maintain backup: 需要子命令 create/verify/restore/drill",
              );
              return 0;
          }
        } catch (e) {
          console.error(`maintain backup: ${(e as Error).message}`);
          return 1;
        }
      }

      if (sub === "reset") {
        const a = parseBackupArgs(["reset", ...args.slice(1)]);
        const deployDir = a.dir ?? ctx.deployDir ?? findDeployDir(ctx.cwd);
        if (deployDir === null) {
          console.error("maintain reset: 未找到 noj-deploy.json");
          return 1;
        }
        try {
          const state = await maintainReset({
            dir: deployDir,
            confirm: a.confirm,
            includeDeployConfigs: a.includeDeployConfigs,
            driver: realDriver(),
          });
          console.log(`重置完成，状态: ${state}`);
          return 0;
        } catch (e) {
          console.error(`maintain reset: ${(e as Error).message}`);
          return 1;
        }
      }

      if (sub === "verify") {
        const rest = args.slice(1);
        let dirOverride: string | undefined;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--dir") dirOverride = rest[++i];
        }
        const deployDir = dirOverride ?? ctx.deployDir ??
          findDeployDir(ctx.cwd);
        if (deployDir === null) {
          console.error("maintain verify: 未找到 noj-deploy.json");
          return 1;
        }
        try {
          const report = await maintainVerify(deployDir);
          if (report.pass) {
            console.log("校验通过");
            return 0;
          }
          for (const e of report.errors) console.error(`  ${e}`);
          return 1;
        } catch (e) {
          console.error(`maintain verify: ${(e as Error).message}`);
          return 1;
        }
      }

      console.error(
        "maintain: 需要子命令 logs/backup/restore/verify/reset/config",
      );
      return 1;
    }
    case "observability": {
      try {
        const a = parseObservabilityArgs(args);
        if (a.sub === "check") {
          const report = await observabilityCheck({
            baseUrl: a.baseUrl,
            checkNotifications: a.checkNotifications,
            alertmanagerUrl: a.alertmanagerUrl,
            http: realHttp(),
          });
          for (const item of report.items) {
            console.log(
              `${item.ok ? "✓" : "✗"} ${item.name}: ${item.detail}`,
            );
          }
          return report.pass ? 0 : 1;
        }
        if (a.sub === "alert-drill") {
          const report = await alertDrill({
            alertmanagerUrl: a.alertmanagerUrl,
            holdSeconds: a.holdSeconds,
            http: realHttp(),
          });
          console.log(
            `告警演练完成：注入=${report.injected} 恢复=${report.resolved}`,
          );
          return 0;
        }
        console.error("observability: 需要子命令 check/alert-drill");
        return 1;
      } catch (e) {
        console.error(`observability: ${(e as Error).message}`);
        return 1;
      }
    }
    case "server": {
      // 仅支持 `server --dir <path> <子命令>` 形式的全局 --dir；
      // 子命令自身（如 problems import --dir）的参数原样透传，不在这里剥离。
      let parsed: ServerCliArgs;
      try {
        parsed = parseServerArgs(args);
      } catch (e) {
        console.error((e as Error).message);
        return 1;
      }
      const context = resolveContext({ cwd: ctx.cwd, dir: parsed.dir });
      return await runServerCommand({
        context,
        args: parsed.args,
        sourceDir: parsed.dir,
      });
    }
    case "judge": {
      try {
        const opts = parseJudgeArgs(args);
        return await runJudgeCommand(opts);
      } catch (e) {
        console.error(`judge: ${(e as Error).message}`);
        return 1;
      }
    }
    case "run-server": {
      let dirOverride: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--dir") dirOverride = args[++i];
      }
      const deployDir = dirOverride ?? ctx.deployDir ?? findDeployDir(ctx.cwd);
      if (deployDir === null) {
        console.error("run-server: 未找到 noj-deploy.json");
        return 1;
      }
      try {
        return await runServerForeground({ dir: deployDir });
      } catch (e) {
        console.error(`run-server: ${(e as Error).message}`);
        return 1;
      }
    }
    default:
      console.error(`未知命令: ${command}`);
      if (!KNOWN_TOP.has(command)) {
        console.error("运行 'noj-cli --help' 查看可用命令。");
      }
      return 1;
  }
}

// 直接执行时作为程序入口。
if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
