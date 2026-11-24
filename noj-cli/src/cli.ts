// noj-cli 入口：全局旗标与 help/version 处理、按命令表分发、统一错误兜底。

import { KNOWN_TOP, PRODUCTION_COMMANDS } from "./commands.ts";
import { VERSION } from "./version.ts";
import { suggestCommand } from "./util/args.ts";
import { parseProblemArgs, runProblem } from "./problem/command.ts";
import { renderProblemHelp } from "./problem/help.ts";
import type { CommandContext } from "./cli-commands/context.ts";
import {
  EXIT_OK,
  EXIT_USAGE,
  extractGlobalFlags,
  handleError,
  isDebug,
  wantsHelp,
} from "./cli-commands/guards.ts";
import { printHelp, renderProductionCommandHelp } from "./cli-commands/help.ts";
import { dispatchProduction } from "./cli-commands/production.ts";
import {
  dispatchContainer,
  parseContainerCommand,
} from "./cli-commands/container.ts";

const HELP_FLAGS = new Set(["--help", "-h", "help"]);
const VERSION_FLAGS = new Set(["--version", "-v", "version"]);

/**
 * 顶层入口，返回进程退出码。
 *
 * - `--debug` 是全局旗标，命令前后均可写，剥离后不进入子命令参数；
 * - `--help`/`--version` 只读且最高优先级，不产生任何副作用（#517 E1/E2）；
 * - 未捕获错误统一转为单行可读信息，退出码 1；`--debug` 时打印完整栈（#517 E3）。
 */
export async function run(argv: string[]): Promise<number> {
  const globals = extractGlobalFlags(argv);
  const debug = globals.debug || isDebug();
  const [command, ...rest] = globals.rest;

  if (command === undefined || HELP_FLAGS.has(command)) {
    console.log(printHelp());
    return EXIT_OK;
  }
  if (VERSION_FLAGS.has(command)) {
    console.log(`noj-cli ${VERSION}`);
    return EXIT_OK;
  }

  try {
    // Tier 3 容器命令按前缀路由（`problem build` 与本地 `problem lint` 共用顶层名）。
    const container = parseContainerCommand(globals.rest);
    if (container.matched) return await dispatchContainer(container, rest);
    return await dispatchCommand(command, rest, { cwd: Deno.cwd() });
  } catch (error) {
    return handleError(command, error, globals.rest, debug);
  }
}

/** 将非 Tier 3 命令分发到对应处理函数。 */
export async function dispatchCommand(
  command: string,
  args: string[],
  ctx: CommandContext,
): Promise<number> {
  if (PRODUCTION_COMMANDS.has(command)) {
    if (wantsHelp(args)) {
      console.log(renderProductionCommandHelp(command));
      return EXIT_OK;
    }
    return await dispatchProduction(ctx, command, args);
  }

  if (command === "problem" || command === "problems") {
    if (args.length === 0 || wantsHelp(args)) {
      console.log(renderProblemHelp());
      return args.length === 0 ? EXIT_USAGE : EXIT_OK;
    }
    return await runProblem(parseProblemArgs(args));
  }

  const suggestion = suggestCommand(command, KNOWN_TOP);
  if (suggestion) {
    console.error(`未知命令: ${command}；你是否想执行: ${suggestion}？`);
  } else {
    console.error(`未知命令: ${command}`);
    console.error("运行 'noj-cli --help' 查看可用命令。");
  }
  return EXIT_USAGE;
}

if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
