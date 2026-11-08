/** `prod/commands/` 共享的命令结果与依赖类型（自 `prod/cli.ts` 拆出，纯搬移）。 */

import type { CommandRunner } from "../../runtime/command.ts";
import type { PromptIO } from "../../tui/io.ts";
import type { Fetcher } from "../bootstrap.ts";

/** 所有生产命令的公共注入点（测试用 fake，生产用真实实现）。 */
export interface ProdCliDeps {
  /** 命令注入点（docker/cosign/lsof/crontab）。 */
  runner?: CommandRunner;
  /** 交互通道（install 向导、uninstall 确认、judge 向导）。 */
  io?: PromptIO;
  /** `isTty` 判定；缺省 `Deno.stdin.isTerminal()`。 */
  isTty?: () => boolean;
  /** Release 资产下载器；缺省全局 fetch。 */
  fetcher?: Fetcher;
  /** 进程环境快照；缺省 `Deno.env.toObject()`。 */
  processEnv?: Record<string, string>;
  /** 人类输出汇聚点（供测试捕获；缺省直写进程流）。 */
  out?: (text: string) => void;
  /** 诊断输出汇聚点（缺省 stderr）。 */
  err?: (text: string) => void;
  /** 时间源（测试注入）。 */
  now?: () => Date;
}

/** 生产命令的执行结果（统一形状，供 CLI 转退出码）。 */
export interface ProdCliResult {
  /** 0 / 1 / 2。 */
  exitCode: number;
  /** 面向用户的结论（人类模式打印；`--json` 时不打印）。 */
  message: string;
}
