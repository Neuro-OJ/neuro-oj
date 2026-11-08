// noj-cli 门面：对外保持既有导出集合；`run()`、`dispatchCommand()` 与
// `removedCommandNotice()` 保留在本文件，其余实现按职责拆到 `cli-commands/`。

import { PRODUCTION_COMMANDS } from "./production.ts";
import { run } from "./cli-commands/run.ts";
import { VERSION } from "./mod.ts";
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
  REMOVED_COMMANDS,
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

  // `stack` = 原 deploy + maintain 合并（#518，验收：覆盖原两者全部能力）

  switch (command) {
    case "version":
      console.log(`noj-cli ${VERSION}`);
      return EXIT_OK;
    case "doctor": {
      // T23：doctor 随双模态一起移除——它的检查项（Docker/Compose/磁盘/内存/端口）
      // 已由 `noj-cli check`（生产配置检查）与 `noj-cli status` 覆盖，
      // 而"同一件事两个入口"正是本次治理要消除的形态。
      console.error(removedCommandNotice("doctor", [
        "生产配置与依赖检查：noj-cli check --dir <安装目录>",
        "服务与容器状态：noj-cli status --dir <安装目录>",
      ]));
      return EXIT_USAGE;
    }
    case "deploy":
    case "stack": {
      // T23：这两个旧名（JSON 编排模式）随双模态一起移除，不再保留别名。
      // 早期（#518）走"先加法后改名 + 别名保留一个版本周期"的过渡策略；
      // 现在配置真相源已唯一（.env.prod），继续保留别名只会让
      // "status/logs/backup 各有两个含义"的混乱延续下去。
      console.error(removedCommandNotice(command, [
        "生产生命周期：noj-cli install | start | stop | restart | status",
        "日志与备份：noj-cli logs | backup | verify",
        "若目录里仍有 noj-deploy.json / noj-secrets.json，可直接删除——" +
        "配置真相源已统一为 .env.prod（与 docker-compose.prod.yml 配套）",
      ]));
      return EXIT_USAGE;
    }
    case "run-server": {
      // T23：run-server 移除（层属运行时，非 CLI 职责，与 #518 判断一致）。
      // 真实开发流程是两段式的，且已在 AGENTS.md §5.3 记录。
      console.error(removedCommandNotice("run-server", [
        "起基础设施：docker compose up -d",
        "各模块前台启动：cd noj-core && deno task dev（ui 同理）",
        "生产前台调试：noj-cli logs --follow 查看容器日志",
      ]));
      return EXIT_USAGE;
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

/**
 * 已移除命令的迁移提示（T23）。
 *
 * 与旧版 `deprecationNotice` 的**关键差异**：那条提示说"已合并为 stack，旧名将在
 * 后续版本移除"——现在旧名确实**已经移除**，继续用"提示"口吻会误导用户以为命令
 * 仍可用。因此这里：
 * - 明确说明**命令已不存在**（而不是"建议改用"）；
 * - 直接给出**替代命令**（逐条可粘贴），而不是指向另一个同样模糊的名字；
 * - 调用方返回 {@link EXIT_USAGE}(2)：命令不存在是用法错误，不是运行失败(1)。
 *
 * 注意本函数名是 `commands_test.ts` 提取 `dispatchCommand` 源码的**结束锚点**
 * （T7 防漂移门禁按行首匹配它来界定 `dispatchCommand` 的正文）。改名必须同步
 * 改那个正则，否则门禁会以"提取落空"的方式变红——那是**有意的**保护。
 */
export function removedCommandNotice(
  legacy: string,
  alternatives: readonly string[],
): string {
  const lines = [
    `命令已移除：${legacy}`,
    "  T23 起 noj-cli 收敛为单模态（配置真相源唯一：.env.prod + docker-compose.prod.yml）。",
    "  替代方式：",
  ];
  for (const alt of alternatives) lines.push(`    - ${alt}`);
  return lines.join("\n");
}

// 直接执行时作为程序入口。
if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
