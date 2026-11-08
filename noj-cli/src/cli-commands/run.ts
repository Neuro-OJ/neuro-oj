// 顶层入口：全局旗标/help/version 处理、命令路由、profile 探测与容器包装。

import { VERSION } from "../mod.ts";
import { PRODUCTION_COMMANDS } from "../production.ts";
import { declaredTopLevelNames } from "../commands.ts";
import { parseDirArg } from "../util/args.ts";
import { parseContainerCommand } from "../container.ts";
import {
  EXIT_OK,
  extractGlobalFlags,
  handleError,
  isDebug,
  wantsHelp,
} from "./guards.ts";
import { extractProfile, parseInstallDirArg } from "./args.ts";
import {
  assertCommandAllowedInProfile,
  detectProfileOrNull,
  PROFILE_AGNOSTIC,
  validateProfileName,
} from "./profile.ts";
import { REMOVED_COMMANDS } from "./registry.ts";
import { printHelp } from "./help.ts";
import { dispatchContainer } from "./container.ts";
import type { CommandContext } from "./context.ts";
import { dispatchCommand } from "../cli.ts";

/**
 * 顶层命令分发。返回进程退出码。
 *
 * 全局异常兜底在此处统一处理（#517 E3）：任何未捕获错误都转为单行可读信息，
 * **不打印栈帧与源码路径**（那既是体验问题也是信息泄露），退出码 1；
 * `--debug` 时例外，打印完整栈供排查。
 *
 * `--help` 严格只读（#517 E1/E2/E12）：优先于任何副作用判定，
 * 因此 `deploy init --help` 不会进入交互向导。
 */
export async function run(argv: string[]): Promise<number> {
  // 全局旗标先剥离：命令前/后均可写，且不进入子命令参数（评审 P2）。
  const globals = extractGlobalFlags(argv);
  const debug = globals.debug || isDebug();
  const command = globals.rest[0];

  if (
    command === undefined || command === "--help" || command === "-h" ||
    command === "help"
  ) {
    console.log(printHelp());
    return EXIT_OK;
  }

  if (command === "--version" || command === "-v") {
    console.log(`noj-cli ${VERSION}`);
    return EXIT_OK;
  }

  try {
    // `--profile` / `--debug` 是 CLI 自身的全局选项，不转发给子命令。
    // 必须放在 try 内：`--profile` 缺值时 extractProfile 抛 UsageError，
    // 若在 try 外抛出会绕过统一兜底，打印栈帧与源码路径（评审 B2）。
    const { profile: explicitProfile, rest: argvRest } = extractProfile(
      globals.rest,
    );
    const topCommand = argvRest[0];
    const topRest = argvRest.slice(1);

    // 全局选项剥离**之后**必须重判 help/version（评审）：`--profile stack --help`、
    // `--debug --help`、`--debug --version` 此前会把 `--help`/`--version`
    // 留在 rest[0]，落到 dispatchCommand 的 default 分支报「未知命令」——
    // 而 help.ts 明确把它们列为全局选项（文档与行为矛盾）。
    // help/version 是只读且最高优先级的（#517 E1/E2），剥离后重新判定。
    if (
      topCommand === "--version" || topCommand === "-v" ||
      topCommand === "version"
    ) {
      console.log(`noj-cli ${VERSION}`);
      return EXIT_OK;
    }
    if (
      topCommand === "--help" || topCommand === "-h" || topCommand === "help"
    ) {
      console.log(printHelp());
      return EXIT_OK;
    }

    if (topCommand === undefined) {
      console.log(printHelp());
      return EXIT_OK;
    }

    // help/version 只读且最高优先级（#517 E1/E2）：上面的检查已覆盖剥离后的
    // 全部取值，这里只需保留 help 分支（version 分支与其等价，无需重复）。
    if (
      topCommand === "--help" || topCommand === "-h" || topCommand === "help"
    ) {
      console.log(printHelp());
      return EXIT_OK;
    }

    // B1（评审）：profile 必须**真正参与分发**。早先只有显式 --profile 会走
    // 校验，自动探测这条链（含「歧义/未命中必须报错」）在真实 CLI 中不可达，
    // 导致 mixed 目录静默按生产路径执行、stack 意图误入 prod 路径。
    // 现在：无显式值时也执行探测（歧义/未命中抛 UsageError）。
    // 纯工具命令（不依赖部署模式）豁免，否则任意目录下 version 都会失败。
    // `--help` 与纯工具命令都不需要探测（只读、与部署模式无关）
    // Tier 3 容器命令（需要在生产安装目录内执行）。
    // 必须先于 profile 探测计算：探测起点取决于是否命中容器（评审 P1）。
    const container = parseContainerCommand([topCommand, ...topRest]);

    const profileAgnostic = PROFILE_AGNOSTIC.has(topCommand) ||
      wantsHelp(topRest);
    // **T24/T26 关键**：生产命令的"目录定位失败"必须由**生产分发**产出
    // （`ProductionDirError` → 退出码 1），不能让探测抢先抛 `UsageError`（2）。
    //
    // 探测的用途是回答"这是个什么模式的目录"，而 T23 收敛为单模态后，这个问题
    // 对生产命令只剩一个答案：**目录对不对**。那正是 `dispatchProduction` 里
    // `findProductionDir` 的职责，且它的报错文案更具体（会指出是哪个路径）。
    // 若让探测先跑，会出现"同一次失败、退出码取决于是否显式给了 --profile"
    // 的分裂（实测：隐式 2、显式 1）——调用方无法据此区分"参数写错"与"目录不对"。
    //
    // 因此：**生产命令跳过 profile 探测**，把目录判定完全交给生产分发。
    // 对非生产命令（Tier 3 容器、problem 等）仍照常探测。
    // **已移除的命令也必须跳过探测**（评审发现，clean checkout 下转红）：
    // 它们的分发路径只打印迁移提示并返回 2，与任何安装目录无关。
    // 若照常探测，"已移除"这个纯粹的用法错误会先撞上
    // "未能识别出生产安装目录"，用户看到的提示与真实原因无关——
    // 而且该测试此前**只在仓根恰好存在 .env.prod 时**才通过（本地残留文件），
    // 干净检出下必然失败（实测：685 passed / 2 failed）。
    // **未知命令同理**：它只会走 dispatchCommand 的 default 分支打印
    // "未知命令 + 拼写建议"，与安装目录无关。若照常探测，`noj-cli instal`
    // 会先报"未能识别出生产安装目录"，把"你拼错了"这条真正有用的信息盖掉
    // （干净检出下的实测失败之一）。
    const isKnownCommand = PRODUCTION_COMMANDS.has(topCommand) ||
      REMOVED_COMMANDS.has(topCommand) || PROFILE_AGNOSTIC.has(topCommand) ||
      declaredTopLevelNames().has(topCommand) ||
      parseContainerCommand([topCommand, ...topRest]).matched;
    const skipProfileDetection = PRODUCTION_COMMANDS.has(topCommand) ||
      REMOVED_COMMANDS.has(topCommand) || !isKnownCommand;
    const effectiveProfile = (profileAgnostic || skipProfileDetection)
      ? (explicitProfile !== undefined
        ? validateProfileName(explicitProfile)!
        : null)
      : (explicitProfile !== undefined
        ? validateProfileName(explicitProfile)!
        // P1：两种安装目录写法参与探测，但**语义不同**：
        // - 普通命令：`--dir` 就是宿主机安装目录，`--install-dir` 是 Tier 3 别名，二者都可用；
        // - Tier 3 容器命令：`--dir` 属于**容器内** noj（如 problems import --dir <包目录>），
        //   不能当作宿主机探测起点——否则题目包位于生产目录之外时，即使 cwd
        //   就是生产安装目录也会报「未能识别 profile」。宿主机目录只能用
        //   `--install-dir`（help 亦如此声明）。
        : detectProfileOrNull(
          container.matched
            ? parseInstallDirArg(topRest)
            : parseDirArg(topRest) ?? parseInstallDirArg(topRest),
        ));

    // 命令必须与判定出的 profile 相容（显式或探测皆然）。
    //
    // 例外：
    // - `--help`/`-h` 必须永远可用且只读（#517 E1/E2）；
    // - **PROFILE_AGNOSTIC 的命令整体豁免**（评审 B1）。它们与部署模式无关
    //   （如 `problem lint` 只是校验本地题目包），若仍走门禁，会出现
    //   「不传 --profile 能用、显式传 --profile stack 反而被拒」的自相矛盾——
    //   而探测歧义时 CLI 自己给出的补救建议正是「请改用 --profile prod|stack」，
    //   用户照做即踩坑。
    // 判定依据是「**是否会路由进 Tier 3 容器**」，而不是只看顶层名
    //（评审 B5）：顶层名 `problem` 同时承担两种角色——
    // `problem build|import` 是 Tier 3（需生产目录），
    // `problem init|lint|pack|push` 是本地出题命令（push 只访问 --server 指定的平台 API）。只看顶层名会让前者逃过门禁。
    const isTier3 = container.matched;
    if (
      effectiveProfile !== null && !wantsHelp(topRest) &&
      (!PROFILE_AGNOSTIC.has(topCommand) || isTier3)
    ) {
      assertCommandAllowedInProfile(effectiveProfile, topCommand);
    }

    // Tier 3：容器包装（纯新增，不影响既有命令）
    if (container.matched) {
      return await dispatchContainer(container, topRest);
    }

    const ctx: CommandContext = { cwd: Deno.cwd() };
    return await dispatchCommand(topCommand, topRest, ctx);
  } catch (error) {
    /* 全局兜底见下 */
    return handleError(command, error, globals.rest, debug);
  }
}
