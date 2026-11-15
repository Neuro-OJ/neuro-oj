// 顶层命令登记表：可分发命令集合、已移除命令、拼写建议用命令集与 --port 解析。

import { parsePortArg } from "../util/args.ts";
import { CONTAINER_COMMANDS } from "../container.ts";
import { PRODUCTION_COMMANDS } from "../production.ts";

/**
 * dispatcher **实际可处理**的顶层命令集合（防漂移门禁的右侧）。
 *
 * 由两处既有事实源合并，**不含**本门禁自带的命令清单：
 * 1. `PRODUCTION_COMMANDS`（`production.ts` 的声明）；
 * 2. `CONTAINER_COMMANDS` 的顶层名（`container.ts` 的 Tier 3 前缀路由，
 *    由 `run()` 在进入 `dispatchCommand` 之前拦下）。
 *
 * `dispatchCommand` 内 `switch` 的 `case` 名字由**测试**从 `cli.ts` 源码提取
 * （见 `commands_test.ts`），生产代码不再在运行时读自身源码——`deno compile`
 * 后的单二进制里没有源码文件。
 *
 * 若 help 声明了任何此处不存在的命令，`commands_test.ts` 的门禁即失败。
 */
export function dispatchableTopLevelNames(): Set<string> {
  const names = new Set<string>(PRODUCTION_COMMANDS);
  for (const prefix of CONTAINER_COMMANDS) {
    const top = prefix[0];
    if (top !== undefined) names.add(top);
  }
  return names;
}

/** 已登记的顶层命令（用于拼写建议，#517 E8）。 */
export const KNOWN_TOP = new Set([
  // #518/#514：新命令必须登记，否则拼写建议看不到它们。
  "maintain",
  "problem",
  "problems",
  "version",
  ...PRODUCTION_COMMANDS,
]);

/** 解析 --port <n>，缺省 8080；非法值抛 {@link UsageError}。 */
export function parsePort(args: string[]): number {
  return parsePortArg(args, 8080);
}
