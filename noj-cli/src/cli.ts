// noj-cli 门面：对外保持既有导出集合；`run()` 与 `dispatchCommand()` 保留在本文件，
// 其余实现按职责拆到 `cli-commands/`。

import { PRODUCTION_COMMANDS } from "./production.ts";
import { run } from "./cli-commands/run.ts";
import { VERSION } from "./version.ts";
import { suggestCommand } from "./util/args.ts";
import { parseProblemArgs, runProblem } from "./problem/command.ts";
import { renderProblemHelp } from "./problem/help.ts";
import type { CommandContext } from "./cli-commands/context.ts";
import { EXIT_OK, EXIT_USAGE, wantsHelp } from "./cli-commands/guards.ts";
import { renderDrillHelp } from "./cli-commands/help.ts";
import { dispatchProduction } from "./cli-commands/production.ts";
import { KNOWN_TOP } from "./cli-commands/registry.ts";
import { renderProductionCommandHelp } from "./cli-commands/help.ts";

// 执行入口、判定工具与生产/容器分发：实现见 `cli-commands/`，此处仅作门面再导出。
export { run } from "./cli-commands/run.ts";
export {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  extractGlobalFlags,
  handleError,
  isDebug,
  wantsHelp,
} from "./cli-commands/guards.ts";
export {
  extractProfile,
  firstPositional,
  formatBytes,
  parseInstallDirArg,
  removeFirstPositional,
  stripCliOwnedFlags,
} from "./cli-commands/args.ts";
export { dispatchContainer } from "./cli-commands/container.ts";
export type { CommandContext } from "./cli-commands/context.ts";
export {
  assertCommandAllowedInProfile,
  detectProfileOrNull,
  type DispatchOptions,
  PROFILE_AGNOSTIC,
  resolveProfile,
  validateProfileName,
} from "./cli-commands/profile.ts";
export {
  dispatchableTopLevelNames,
  KNOWN_TOP,
  parsePort,
} from "./cli-commands/registry.ts";
export { printHelp, renderDrillHelp } from "./cli-commands/help.ts";

// `backup` 子命令参数解析已抽到 ./backup-args.ts（单文件规模棘轮）。
export { type BackupArgs, parseBackupArgs } from "./backup-args.ts";

/** 将命令分发到对应处理函数。供测试与 run 共用。 */
export async function dispatchCommand(
  command: string,
  args: string[],
  ctx: CommandContext,
): Promise<number> {
  // `backup drill` 的 help 必须显示 drill 自己的选项（#516 验收：
  // help 文本要明确「分钟级、耗 Docker」），不能被通用 backup help 抢先。
  if (command === "backup" && args[0] === "drill" && wantsHelp(args.slice(1))) {
    console.log(renderDrillHelp());
    return EXIT_OK;
  }
  // 生产命令的 help 由 CLI 自己回答（#517 E12）
  if (PRODUCTION_COMMANDS.has(command) && wantsHelp(args)) {
    console.log(renderProductionCommandHelp(command));
    return EXIT_OK;
  }
  // 生产命令一律调用**原生实现**（T24 接线，R1 收口）。
  // 此前这里转发给 `bash <dir>/scripts/deploy/production.sh`——那是 src 内唯一的
  // 脚本调用（R1 违例），也是"纯 TS 重写"最后一块非 TS 拼图。
  if (PRODUCTION_COMMANDS.has(command)) {
    return await dispatchProduction(ctx, command, args);
  }

  // `problem` = 题目包管理（#514）：init / lint / pack / push
  if (command === "problem" || command === "problems") {
    if (args.length === 0) {
      console.log(renderProblemHelp());
      return EXIT_USAGE;
    }
    if (wantsHelp(args)) {
      console.log(renderProblemHelp());
      return EXIT_OK;
    }
    return await runProblem(parseProblemArgs(args));
  }

  switch (command) {
    case "version":
      console.log(`noj-cli ${VERSION}`);
      return EXIT_OK;
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

// 直接执行时作为程序入口。（本行是 commands_test.ts 提取 dispatchCommand 的结束锚点）
if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
