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

/**
 * 已移除的命令（T23 的双模态收敛）。
 *
 * 这些名字**不再是命令**：分发时只打印迁移提示并返回用法错误 2。
 * 它们必须与 {@link PRODUCTION_COMMANDS} 一样**跳过 profile 探测**——
 * 否则一个纯粹的用法错误会先报"未能识别出生产安装目录"，掩盖真实原因。
 *
 * 唯一事实源：`dispatchCommand` 里处理它们的分支必须与本集合一致
 * （`commands_test.ts` 的门禁断言两者同步）。
 */
export const REMOVED_COMMANDS = new Set([
  "doctor",
  "deploy",
  "stack",
  "run-server",
]);

/** 已登记的顶层命令（用于拼写建议，#517 E8）。 */
export const KNOWN_TOP = new Set([
  // #518/#514：新命令必须登记，否则拼写建议看不到它们。
  // T23：`doctor`/`deploy`/`stack`/`run-server` 已随双模态移除，因此不再登记——
  // 它们不是"可用命令"，出现在拼写建议里会误导用户。`maintain` 于 P1d 以
  // Tier 3 容器命令重新引入（维护模式/排空），故重新登记。
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
