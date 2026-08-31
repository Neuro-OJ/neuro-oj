import { findDeployDir } from "./util/find_deploy_dir.ts";
import { VERSION } from "./mod.ts";

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
    "  doctor        环境检测（stub）",
    "  deploy        部署生命周期 init/up/down/restart/status（stub）",
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

/** 将命令分发到对应 stub 处理函数。供测试与 run 共用。 */
export function dispatchCommand(
  command: string,
  args: string[],
  ctx: CommandContext,
): number {
  switch (command) {
    case "version":
      console.log(`noj-cli ${VERSION}`);
      return 0;
    case "doctor":
      console.log("doctor: 环境检测（P0 占位，逻辑留待后续计划）");
      return 0;
    case "deploy": {
      const sub = args[0] ?? "";
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
