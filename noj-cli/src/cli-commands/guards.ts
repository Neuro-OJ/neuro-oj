// 轻量判定与错误输出：退出码常量、help/debug 判定、全局旗标剥离与错误映射。

import { ProductionDirError } from "../production.ts";
import { UsageError } from "../util/args.ts";

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
 * 剥离 CLI 自有的全局旗标，返回剩余参数与是否命中 `--debug`。
 *
 * 评审 P2（#518）：`--debug` 被帮助声明为全局选项，但 `run()` 曾直接把
 * `argv[0]` 当作命令，`noj-cli --debug status` 因此落入未知命令分支返回 2，
 * 文档承诺的调试模式在命令名前不可用。
 *
 * 在解析命令之前统一剥离，两个位置都可用；同时 `--debug` 不会进入子命令
 * 参数解析，也不会透传到底层脚本或容器。
 */
export function extractGlobalFlags(args: string[]): {
  rest: string[];
  debug: boolean;
} {
  const rest: string[] = [];
  let debug = false;
  for (const arg of args) {
    if (arg === "--debug") {
      debug = true;
      continue;
    }
    rest.push(arg);
  }
  return { rest, debug };
}

/** 统一的错误输出与退出码映射（供 run 与测试复用）。 */
export function handleError(
  command: string,
  error: unknown,
  argv: string[] = [],
  debugOverride?: boolean,
): number {
  const debug = debugOverride ?? isDebug(argv);
  if (error instanceof UsageError) {
    console.error(`noj-cli ${command}: ${error.message}`);
    return EXIT_USAGE;
  }
  // ProductionDirError 与未预期错误都是「运行失败」，但后者才需要栈帧提示
  const classified = error instanceof ProductionDirError;
  console.error(`noj-cli ${command}: ${(error as Error).message}`);
  if (debug) {
    console.error((error as Error).stack ?? "");
  } else if (!classified) {
    console.error("（加 --debug 查看完整栈）");
  }
  return EXIT_FAILURE;
}
