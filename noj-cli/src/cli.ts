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
import { COLOR_MODES, type ColorMode, parseColorMode } from "./util/color.ts";
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
import {
  PRODUCTION_COMMANDS,
  ProductionDirError,
  runProduction,
} from "./production.ts";
import { renderCommandHelp, renderHelp } from "./help.ts";
import { nonInteractiveAdvice } from "./init/non_interactive.ts";
import {
  parseDirArg,
  parsePortArg,
  suggestCommand,
  UsageError,
  validatePort,
} from "./util/args.ts";

/** CLI 执行上下文，供各子命令共享。 */
export interface CommandContext {
  cwd: string;
  /** 向上查找到的部署目录，找不到为 null。 */
  deployDir: string | null;
}

/** 退出码语义（#517 E9）。 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** 判断参数中是否请求帮助（`--help` 或 `-h`）。 */
export function wantsHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/** 是否开启调试栈输出（`--debug` 或环境变量）。 */
export function isDebug(args: string[] = []): boolean {
  if (args.includes("--debug")) return true;
  const env = Deno.env.get("NOJ_CLI_DEBUG");
  return env === "1" || env === "true";
}

/**
 * 顶层命令分发。返回进程退出码。
 *
 * 全局异常兜底在此处统一处理（#517 E3）：任何未捕获错误都转为单行可读信息，
 * **不打印栈帧与源码路径**（那既是体验问题也是信息泄露），退出码 1；
 * `--debug` 时例外，打印完整栈供排查。
 *
 * `--help` 严格只读（#517 E1/E2/E12）：优先于任何副作用判定，
 * 因此 `deploy init --help` 不会进入交互向导。
 */
export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (
    command === undefined || command === "--help" || command === "-h" ||
    command === "help"
  ) {
    console.log(printHelp());
    return EXIT_OK;
  }

  if (command === "--version" || command === "-v") {
    console.log(`noj-cli ${VERSION}`);
    return EXIT_OK;
  }

  try {
    const ctx: CommandContext = {
      cwd: Deno.cwd(),
      deployDir: findDeployDir(),
    };
    return await dispatchCommand(command, rest, ctx);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`noj-cli ${command}: ${error.message}`);
      return EXIT_USAGE;
    }
    if (error instanceof ProductionDirError) {
      console.error(`noj-cli ${command}: ${error.message}`);
      if (isDebug(argv)) console.error((error as Error).stack ?? "");
      return EXIT_FAILURE;
    }
    console.error(`noj-cli ${command}: ${(error as Error).message}`);
    if (isDebug(argv)) {
      console.error((error as Error).stack ?? "");
    } else {
      console.error("（加 --debug 查看完整栈）");
    }
    return EXIT_FAILURE;
  }
}

/** 生成顶层帮助文本（等价于 {@link renderHelp}，保留旧导出名）。 */
export function printHelp(): string {
  return renderHelp();
}

/** 已登记的顶层命令（用于拼写建议，#517 E8）。 */
export const KNOWN_TOP = new Set([
  "doctor",
  "deploy",
  "maintain",
  "run-server",
  "version",
  ...PRODUCTION_COMMANDS,
]);

/** 解析 --port <n>，缺省 8080；非法值抛 {@link UsageError}。 */
export function parsePort(args: string[]): number {
  return parsePortArg(args, 8080);
}

/** 解析 deploy init 选项：--mode dev|prod、--port <n>、--dir <path>。 */
export function parseInitOptions(args: string[], cwd: string): InitOptions {
  let mode: "dev" | "prod" | undefined;
  let port: number | undefined;

  const modeIdx = args.indexOf("--mode");
  if (modeIdx !== -1) {
    const raw = args[modeIdx + 1];
    if (raw !== "dev" && raw !== "prod") {
      throw new UsageError(
        `--mode 仅支持 dev/prod，收到 "${raw ?? ""}"`,
      );
    }
    mode = raw;
  }
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1) {
    port = validatePort(args[portIdx + 1]);
  }

  return { mode, port, installDir: parseDirArg(args) ?? cwd };
}

/** 解析 deploy 生命周期参数：目前仅 --dir <path>。 */
export function parseDeployArgs(args: string[]): { dir: string | undefined } {
  return { dir: parseDirArg(args) };
}

/**
 * 解析 maintain 参数：`--dir <path>`、`--follow`、`--color[=]<auto|always|never>`、
 * 位置参数 modules。
 */
export function parseMaintainArgs(args: string[]): {
  dir: string | undefined;
  follow: boolean;
  color: ColorMode;
  modules: string | undefined;
} {
  const dir = parseDirArg(args);
  let follow = false;
  let color: ColorMode = "auto";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dir" || a.startsWith("--dir=")) {
      // 已由 parseDirArg 统一消费（含缺值报错），此处跳过其值
      if (a === "--dir") i++;
      continue;
    }
    if (a === "--follow") {
      follow = true;
    } else if (a === "--color") {
      // 支持 `--color always` 与 `--color=always` 两种写法。
      //
      // 只在该值**确实是合法颜色模式**时才消费下一个参数（评审 P2）：
      // 早先对任意非 `-` 开头的参数都当作颜色值，于是 `--color server`
      // 会把模块名 `server` 吞掉（`modules` 变成 undefined），
      // `maintain logs --color server` 因此丢失目标服务。
      const next = args[i + 1];
      if (
        next !== undefined &&
        // COLOR_MODES 是 readonly ColorMode[]；这里比对的是任意用户输入字符串，
        // 故先放宽为 string[]（否则 TS2345）。单一事实源仍在 COLOR_MODES。
        (COLOR_MODES as readonly string[]).includes(next.trim().toLowerCase())
      ) {
        color = parseColorMode(next);
        i++;
      } else {
        // 裸 `--color` 或后跟非法值：视为强制开（与常见 CLI 约定一致），
        // 非法值不报错也不吞参，交由位置参数处理。
        color = "always";
      }
    } else if (a.startsWith("--color=")) {
      color = parseColorMode(a.slice("--color=".length));
    } else {
      positional.push(a);
    }
  }
  return { dir, follow, color, modules: positional[0] };
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
  const rest = args.slice(1);
  // `--dir` 统一解析（支持 `--dir=`，缺值报错）；下面的 switch 跳过它。
  out.dir = parseDirArg(rest);
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--dir" || a.startsWith("--dir=")) {
      if (a === "--dir") i++;
      continue;
    }
    const takeValue = (name: string): string => {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${name} 需要一个值`);
      }
      i++;
      return value;
    };
    switch (a) {
      case "--backup-dir":
        out.backupDir = takeValue("--backup-dir");
        break;
      case "--passphrase-file":
        out.passphraseFile = takeValue("--passphrase-file");
        break;
      case "--zstd-level": {
        const raw = takeValue("--zstd-level");
        const level = Number(raw);
        if (!Number.isInteger(level) || level < 1 || level > 22) {
          throw new UsageError(
            `--zstd-level 需要一个 1-22 的整数，收到 "${raw}"`,
          );
        }
        out.zstdLevel = level;
        break;
      }
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
        out.report = takeValue("--report");
        break;
      default:
        positional.push(a);
    }
  }
  out.snapshot = positional[0];
  return out;
}

/** 解析出部署目录；未找到返回 null（调用方负责报错文案）。 */
function resolveDeployDir(
  dirOverride: string | undefined,
  ctx: CommandContext,
): string | null {
  return dirOverride ?? ctx.deployDir ?? findDeployDir(ctx.cwd);
}

/** 将命令分发到对应处理函数。供测试与 run 共用。 */
export async function dispatchCommand(
  command: string,
  args: string[],
  ctx: CommandContext,
): Promise<number> {
  // 生产命令的 help 由 CLI 自己回答，不转发给 bash（#517 E12）
  if (PRODUCTION_COMMANDS.has(command) && wantsHelp(args)) {
    console.log(renderProductionCommandHelp(command));
    return EXIT_OK;
  }
  if (PRODUCTION_COMMANDS.has(command)) {
    return await runProduction(command, args);
  }

  switch (command) {
    case "version":
      console.log(`noj-cli ${VERSION}`);
      return EXIT_OK;
    case "doctor": {
      if (wantsHelp(args)) {
        console.log(
          renderCommandHelp("noj-cli doctor [--port <n>] [--dir <path>]", [
            "环境检测：Docker / Compose / 磁盘 / 内存 / 端口占用。",
            "",
            "选项:",
            "  --port <n>     检测该端口是否被占用（默认 8080）",
            "  --dir <path>   部署目录（默认当前目录及祖先）",
          ]),
        );
        return EXIT_OK;
      }
      const port = parsePort(args);
      const dirOverride = parseDirArg(args);
      const installDir = dirOverride ?? ctx.deployDir ?? ctx.cwd;
      const report = await runDoctor(realProbe(), { port, installDir });
      console.log(formatReport(report));
      return report.failed ? EXIT_FAILURE : EXIT_OK;
    }
    case "deploy": {
      const sub = args[0] ?? "";
      // `deploy <sub> --help` 必须只读：绝不能进入 init 向导（#517 E2）
      if (wantsHelp(args.slice(1)) || sub === "--help" || sub === "-h") {
        console.log(renderDeployHelp(sub));
        return EXIT_OK;
      }
      if (sub === "init") {
        const opts = parseInitOptions(args.slice(1), ctx.cwd);
        // 非 TTY 时一律拒绝进入交互向导（#517 E10）。
        //
        // 评审修正：早先这里有 `--yes` 逃生阀，但它并非已实现的非交互模式——
        // 向导仍逐个提问，读不到输入时无限循环刷屏（实测 10 秒 237 万行），
        // 比修复前更糟，且与 nonInteractiveAdvice 推荐的命令自相矛盾。
        // 因此移除该逃生阀：要么补齐真正的非交互路径，要么明确拒绝。
        const isTty = Deno.stdin.isTerminal();
        const advice = nonInteractiveAdvice(isTty, opts.mode !== undefined);
        if (advice) {
          console.error(`deploy init: ${advice.message}`);
          return EXIT_USAGE;
        }
        const { config, secrets } = await runInitWizard(
          realIO(),
          realProbe(),
          opts,
        );
        await saveDeployment(opts.installDir, config, secrets);
        console.log(
          `已写入 ${opts.installDir}/noj-deploy.json 与 noj-secrets.json`,
        );
        return EXIT_OK;
      }
      const { dir } = parseDeployArgs(args.slice(1));
      const deployDir = resolveDeployDir(dir, ctx);
      if (deployDir === null) {
        console.error("deploy: 未找到 noj-deploy.json，请先运行 deploy init");
        return EXIT_FAILURE;
      }
      switch (sub) {
        case "up": {
          const state = await deployUp({ dir: deployDir });
          console.log(`deploy up 完成，状态: ${state}`);
          return EXIT_OK;
        }
        case "down": {
          const state = await deployDown({ dir: deployDir });
          console.log(`deploy down 完成，状态: ${state}`);
          return EXIT_OK;
        }
        case "restart": {
          const state = await deployRestart({ dir: deployDir });
          console.log(`deploy restart 完成，状态: ${state}`);
          return EXIT_OK;
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
          return EXIT_OK;
        }
        default:
          console.error("deploy: 需要子命令 init/up/down/restart/status");
          console.error("运行 'noj-cli deploy --help' 查看用法。");
          return EXIT_USAGE;
      }
    }
    case "maintain": {
      const sub = args[0] ?? "";
      if (wantsHelp(args.slice(1)) || sub === "--help" || sub === "-h") {
        console.log(renderMaintainHelp(sub));
        return EXIT_OK;
      }
      if (sub === "restore") {
        return await dispatchCommand("maintain", [
          "backup",
          "restore",
          ...args.slice(1),
        ], ctx);
      }
      if (sub === "logs") {
        const { dir, follow, color, modules } = parseMaintainArgs(
          args.slice(1),
        );
        const deployDir = resolveDeployDir(dir, ctx);
        if (deployDir === null) {
          console.error(
            "maintain logs: 未找到 noj-deploy.json，请先运行 deploy init",
          );
          return EXIT_FAILURE;
        }
        try {
          const { config } = await loadDeployment(deployDir);
          const mods = parseModulesArg(modules, config);
          await maintainLogs({
            dir: deployDir,
            modules: mods,
            follow,
            color,
          });
          return EXIT_OK;
        } catch (e) {
          console.error(`maintain logs: ${(e as Error).message}`);
          return EXIT_FAILURE;
        }
      }
      if (sub === "config") {
        const rest = args.slice(1);
        const dirOverride = parseDirArg(rest);
        // 按 **`--dir` 语法**跳过（而非值相等比较）：早先用 `a !== dirOverride`
        // 会误删与目录同名的业务参数，例如
        // `config set DATA_DIR /tmp/x --dir /tmp/x` 会丢掉 `/tmp/x`。
        const positional: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i]!;
          if (a === "--dir") {
            i++; // 连同值跳过
            continue;
          }
          if (a.startsWith("--dir=")) continue;
          positional.push(a);
        }
        const action = positional[0] ?? "";
        const deployDir = resolveDeployDir(dirOverride, ctx);
        if (deployDir === null) {
          console.error(
            "maintain config: 未找到 noj-deploy.json，请先运行 deploy init",
          );
          return EXIT_FAILURE;
        }
        try {
          switch (action) {
            case "check": {
              const issues = await configCheck(deployDir);
              if (issues.length === 0) {
                console.log("配置校验通过");
                return EXIT_OK;
              }
              for (const i of issues) {
                console.error(`  ${i.path}: ${i.message}`);
              }
              return EXIT_FAILURE;
            }
            case "show": {
              console.log(await configShow(deployDir));
              return EXIT_OK;
            }
            case "set": {
              const key = positional[1];
              const value = positional[2];
              if (key === undefined || value === undefined) {
                console.error("maintain config set: 需要 <key> <value>");
                return EXIT_USAGE;
              }
              await configSet(deployDir, key, value);
              console.log(`已更新 ${key} = ${value}`);
              return EXIT_OK;
            }
            default:
              console.error("maintain config: 需要子命令 check/show/set");
              return EXIT_USAGE;
          }
        } catch (e) {
          console.error(`maintain config: ${(e as Error).message}`);
          return EXIT_FAILURE;
        }
      }
      if (sub === "backup") {
        const a = parseBackupArgs(args.slice(1));
        const deployDir = resolveDeployDir(a.dir, ctx);
        if (deployDir === null) {
          console.error("maintain backup: 未找到 noj-deploy.json");
          return EXIT_FAILURE;
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
              return EXIT_OK;
            }
            case "verify": {
              if (a.snapshot === undefined) {
                console.error("maintain backup verify: 需要 <snapshot> 路径");
                return EXIT_USAGE;
              }
              const report = await backupVerify({
                snapshotPath: a.snapshot,
                passphraseFile: a.passphraseFile,
                driver: realDriver(),
              });
              if (report.pass) {
                console.log("校验通过");
                return EXIT_OK;
              }
              for (const e of report.errors) console.error(`  ${e}`);
              return EXIT_FAILURE;
            }
            case "restore": {
              if (a.snapshot === undefined) {
                console.error("maintain backup restore: 需要 <snapshot> 路径");
                return EXIT_USAGE;
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
              return EXIT_OK;
            }
            case "drill": {
              if (a.snapshot === undefined) {
                console.error("maintain backup drill: 需要 <snapshot> 路径");
                return EXIT_USAGE;
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
              return report.pass ? EXIT_OK : EXIT_FAILURE;
            }
            default:
              console.error(
                "maintain backup: 需要子命令 create/verify/restore/drill",
              );
              return EXIT_USAGE;
          }
        } catch (e) {
          console.error(`maintain backup: ${(e as Error).message}`);
          return EXIT_FAILURE;
        }
      }

      if (sub === "reset") {
        const a = parseBackupArgs(["reset", ...args.slice(1)]);
        const deployDir = resolveDeployDir(a.dir, ctx);
        if (deployDir === null) {
          console.error("maintain reset: 未找到 noj-deploy.json");
          return EXIT_FAILURE;
        }
        try {
          const state = await maintainReset({
            dir: deployDir,
            confirm: a.confirm,
            includeDeployConfigs: a.includeDeployConfigs,
            driver: realDriver(),
          });
          console.log(`重置完成，状态: ${state}`);
          return EXIT_OK;
        } catch (e) {
          console.error(`maintain reset: ${(e as Error).message}`);
          return EXIT_FAILURE;
        }
      }

      if (sub === "verify") {
        const dirOverride = parseDirArg(args.slice(1));
        const deployDir = resolveDeployDir(dirOverride, ctx);
        if (deployDir === null) {
          console.error("maintain verify: 未找到 noj-deploy.json");
          return EXIT_FAILURE;
        }
        try {
          const report = await maintainVerify(deployDir);
          if (report.pass) {
            console.log("校验通过");
            return EXIT_OK;
          }
          for (const e of report.errors) console.error(`  ${e}`);
          return EXIT_FAILURE;
        } catch (e) {
          console.error(`maintain verify: ${(e as Error).message}`);
          return EXIT_FAILURE;
        }
      }

      console.error(
        "maintain: 需要子命令 logs/backup/restore/verify/reset/config",
      );
      console.error("运行 'noj-cli maintain --help' 查看用法。");
      return EXIT_USAGE;
    }
    case "run-server": {
      if (wantsHelp(args)) {
        console.log(renderCommandHelp("noj-cli run-server [--dir <path>]", [
          "前台运行 noj-server 二进制（阻塞当前终端）。",
          "",
          "选项:",
          "  --dir <path>   部署目录（默认当前目录及祖先）",
        ]));
        return EXIT_OK;
      }
      const dirOverride = parseDirArg(args);
      const deployDir = resolveDeployDir(dirOverride, ctx);
      if (deployDir === null) {
        console.error("run-server: 未找到 noj-deploy.json");
        return EXIT_FAILURE;
      }
      return await runServerForeground({ dir: deployDir });
    }
    default: {
      const suggestion = suggestCommand(command, KNOWN_TOP);
      if (suggestion) {
        console.error(`未知命令: ${command}；你是否想执行: ${suggestion}？`);
      } else {
        console.error(`未知命令: ${command}`);
        console.error("运行 'noj-cli --help' 查看可用命令。");
      }
      return EXIT_USAGE;
    }
  }
}

/** 生产命令的 CLI 侧帮助（不转发给底层 bash 脚本，#517 E12）。 */
function renderProductionCommandHelp(command: string): string {
  const summaries: Record<string, string> = {
    install: "生产安装（写入 .env.prod 并启动 Docker Compose 栈）",
    check: "生产环境检测（Linux/Docker/Compose/磁盘/端口）",
    start: "启动生产服务",
    stop: "停止生产服务",
    restart: "重启生产服务",
    status: "查看生产服务状态",
    logs: "查看生产服务日志",
    update: "同步部署文件、备份并升级生产服务",
    upgrade: "update 的别名",
    backup: "生产备份；子命令 create/verify/restore/drill",
    verify: "校验生产配置与镜像签名",
    config: "校验生产配置（不校验镜像签名）",
    uninstall: "卸载生产服务；--all 删除全部数据，需确认",
  };
  return renderCommandHelp(`noj-cli ${command} [选项]`, [
    summaries[command] ?? "生产命令",
    "",
    "说明:",
    "  该命令需要完整的生产安装目录（含 scripts/deploy/production.sh 与",
    "  docker-compose.prod.yml）。使用 --dir <path> 指定，或在安装目录内执行。",
    "  --help 由 noj-cli 自己回答，不会转发给底层脚本。",
  ]);
}

/** deploy 子命令帮助。 */
function renderDeployHelp(sub: string): string {
  if (sub === "init") {
    return renderCommandHelp("noj-cli deploy init [选项]", [
      "交互式生成 noj-deploy.json 与 noj-secrets.json。",
      "",
      "选项:",
      "  --mode dev|prod      部署模式",
      "  --port <n>           服务端口（1-65535）",
      "  --dir <path>         安装目录（默认当前目录）",
      "",
      "提示: --help 只读，不会创建任何文件。",
    ]);
  }
  return renderCommandHelp("noj-cli deploy <子命令> [选项]", [
    "JSON 编排模式的部署生命周期。",
    "",
    "子命令:",
    "  init                  交互式初始化配置",
    "  up                    启动服务",
    "  down                  停止服务",
    "  restart               重启服务",
    "  status                查看状态",
    "",
    "选项:",
    "  --dir <path>          部署目录（默认当前目录及祖先）",
  ]);
}

/** maintain 子命令帮助。 */
function renderMaintainHelp(sub: string): string {
  if (sub === "backup") {
    return renderCommandHelp("noj-cli maintain backup <子命令> [选项]", [
      "JSON 编排模式的备份运维。",
      "",
      "子命令:",
      "  create                创建备份",
      "  verify <snapshot>     校验备份完整性",
      "  restore <snapshot>    恢复备份（需 --confirm）",
      "  drill <snapshot>      恢复演练",
      "",
      "选项:",
      "  --dir <path>          部署目录",
      "  --backup-dir <path>   备份输出目录",
      "  --passphrase-file <p> 口令文件",
      "  --zstd-level <n>      压缩级别（1-22，默认 15）",
      "  --no-encrypt          不加密（需显式指定）",
      "  --confirm             确认危险操作",
    ]);
  }
  return renderCommandHelp("noj-cli maintain <子命令> [选项]", [
    "JSON 编排模式的运维命令。",
    "",
    "子命令:",
    "  logs                  查看日志（--follow / --color）",
    "  config check|show|set 配置校验与查看",
    "  verify                配置校验",
    "  reset                 重置部署（需 --confirm）",
    "  backup                备份（create/verify/restore/drill）",
    "  restore               等价于 backup restore",
  ]);
}

// 直接执行时作为程序入口。
if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
