/**
 * 命令级帮助文本的渲染原语。
 *
 * 历史（#517 E5/E11）：本模块曾同时维护一份顶层命令分区清单
 * （`HELP_SECTIONS`/`renderHelp`），与 `cli.ts` 里多处手写文案重复，
 * 已实测漂移（`backup` 漏列 `list`/`prune`）。
 *
 * Task 7 起，**顶层命令清单的唯一事实源是 `commands.ts`**
 * （`COMMANDS` + `renderCommandList`）；本模块只保留各子命令
 * `<cmd> --help` 共用的渲染原语，不再持有任何命令清单副本。
 */

/** 生成某个子命令的用法文本（供 `<cmd> --help` 使用）。 */
export function renderCommandHelp(
  usage: string,
  body: string[],
): string {
  return [`用法: ${usage}`, "", ...body, ""].join("\n");
}
