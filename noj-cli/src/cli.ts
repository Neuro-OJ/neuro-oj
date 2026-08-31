import { findDeployDir } from "./util/find_deploy_dir.ts";
import { VERSION } from "./mod.ts";
import { realProbe } from "./doctor/probe.ts";
import { runDoctor } from "./doctor/doctor.ts";
import { formatReport } from "./doctor/report.ts";
import { realIO } from "./tui/io.ts";
import { type InitOptions, runInitWizard } from "./init/wizard.ts";
import { saveDeployment } from "./config/save.ts";

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
    "  doctor        环境检测",
    "  deploy        部署生命周期 init/up/down/restart/status（init 已实现）",
    "  maintain      运维 logs/backup/restore/verify/reset/config（stub）",
    "  run-server    运行 noj-server（stub）",
    "  version       显示版本",
    "",
  ].join("\n");
}

const DEPLOY_SUBCOMMANDS = ["init", "up", "down", "restart", "status"];
const MAINTAIN_SUBCOMMANDS = [
  "logs",
  "backup",
  "restore",
  "verify",
  "reset",
  "config",
];

const KNOWN_TOP = new Set([
  "doctor",
  "deploy",
  "maintain",
  "run-server",
  "version",
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

/** 将命令分发到对应处理函数。供测试与 run 共用。 */
export async function dispatchCommand(
  command: string,
  args: string[],
  ctx: CommandContext,
): Promise<number> {
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
      if (DEPLOY_SUBCOMMANDS.includes(sub)) {
        console.log(
          `deploy ${sub}: 生命周期逻辑留待后续计划（部署目录: ${
            ctx.deployDir ?? "未找到"
          }）`,
        );
      } else {
        console.log(
          "deploy: 需要子命令 init/up/down/restart/status（P0 占位）",
        );
      }
      return 0;
    }
    case "maintain": {
      const sub = args[0] ?? "";
      if (MAINTAIN_SUBCOMMANDS.includes(sub)) {
        console.log(`maintain ${sub}: 运维逻辑留待后续计划`);
      } else {
        console.log(
          "maintain: 需要子命令 logs/backup/restore/verify/reset/config（P0 占位）",
        );
      }
      return 0;
    }
    case "run-server":
      console.log("run-server: 运行 noj-server 逻辑留待后续计划");
      return 0;
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
