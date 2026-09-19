import { resolve } from "@std/path";
import { VERSION } from "./mod.ts";
import {
  findProductionDir,
  PRODUCTION_COMMANDS,
  ProductionDirError,
} from "./production.ts";
import {
  flagValue,
  hasFlag,
  hasJson,
  parseProdArgs,
  positionals,
  runBackupCreate,
  runBackupList,
  runBackupPrune,
  runBackupRestorePlan,
  runBackupSchedule,
  runBackupVerify,
  runProdCheck,
  runProdInstall,
  runProdLogs,
  runProdRestart,
  runProdStart,
  runProdStatus,
  runProdStop,
  runProdUninstall,
  runProdUpdate,
} from "./prod/cli.ts";
import { renderCommandHelp } from "./help.ts";
import { renderCommandList } from "./commands.ts";
import {
  parseDirArg,
  parsePortArg,
  suggestCommand,
  UsageError,
} from "./util/args.ts";
import { CONTAINER_COMMANDS, parseContainerCommand } from "./container.ts";
import { runDrill } from "./prod/drill/drill.ts";
import { realRunner } from "./runtime/command.ts";
import { parseProblemArgs, runProblem } from "./problem/command.ts";
import { renderProblemHelp } from "./problem/help.ts";
import { runInContainer } from "./container_run.ts";
import { detectProfile, type ProfileName, realProfileFs } from "./profile.ts";

/**
 * CLI 执行上下文，供各子命令共享。
 *
 * T23：原先还有 `deployDir`（由 `findDeployDir()` 向上查找 `noj-deploy.json`
 * 得到）——那是 JSON 编排模式的目录发现。该模态删除后，生产目录改由
 * `findProductionDir()` 单独负责（它按 `PRODUCTION_MARKERS` 判定，并会检查
 * 已安装二进制的位置），因此这个字段失去意义。
 */
export interface CommandContext {
  cwd: string;
}

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

    // 全局选项剥离**之后**必须重新检查 help/version（评审 B-2）：
    // `--profile stack --help`、`--debug --help`、`--debug --version`
    // 此前会落到「未知命令: --help」或探测报错。
    // help/version 只读且最高优先级（#517 E1/E2），剥离后它们可能在首位。
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
    const skipProfileDetection = PRODUCTION_COMMANDS.has(topCommand);
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
    // `problem init|lint|pack` 是本地出题命令。只看顶层名会让前者逃过门禁。
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

/**
 * 剥离 CLI 自身的全局选项（`--profile`、`--debug`），其余原样保留。
 *
 * **`--debug` 必须一并剥离**（评审 B3）：它是 noj-cli 自己的排查开关，
 * 不是子命令/容器内 noj 的选项。若不剥离：
 * - 生产命令会把 `--debug` 传给 `production.sh`（其参数契约不接受）；
 * - Tier 3 会把它透传进容器，容器内 noj 报「未知选项」；
 * - 放在子命令之后还会被当成未知顶层命令。
 * 三种表现都是「help 说是全局选项、实际不可用」。
 *
 * 这两个选项语义属于 noj-cli 本身，**不能**透传给子命令或底层脚本。
 */
export function extractProfile(argv: string[]): {
  profile: string | undefined;
  rest: string[];
} {
  let profile: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--debug") {
      // 评审 B3：--debug 是 CLI 自身的全局排查开关，必须在**顶层**剥离。
      // 否则放在子命令前会被当成未知命令，放在子命令后会被转发给
      // production.sh 或透传进容器（help 却把它列为全局选项）。
      continue;
    }
    if (arg === "--profile") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError("--profile 需要一个值（prod 或 stack）");
      }
      profile = value;
      i++;
    } else if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    } else {
      rest.push(arg);
    }
  }
  return { profile, rest };
}

/**
 * 执行 Tier 3 容器命令。
 *
 * 需要生产安装目录（含 `docker-compose.prod.yml` 与 `.env.prod`）。
 * `--dry-run` 只打印将执行的命令。退出码原样透传。
 */
export async function dispatchContainer(
  match: { service: string; args: string[] },
  tail: string[],
): Promise<number> {
  if (wantsHelp(tail)) {
    console.log(renderCommandHelp(
      `noj-cli ${match.args.join(" ")} [选项]`,
      [
        "在 noj-server 容器内执行服务端管理命令（Tier 3）。",
        "",
        "说明:",
        `  等价于 docker compose … run --rm --entrypoint /app/bin/noj ${match.service} ${
          match.args.join(" ")
        }`,
        "  交互式输入（如隐藏密码）会透传到容器。",
        "",
        "选项:",
        "  --install-dir <path>   生产安装目录（CLI 自身选项）",
        "  --dry-run              仅打印将执行的 compose 命令",
        "",
        "注：--dir 属于容器内命令自身的选项（如 problems import --dir），",
        "    会原样透传；指定生产安装目录请用 --install-dir。",
      ],
    ));
    return EXIT_OK;
  }

  const dryRun = tail.includes("--dry-run");
  // 评审 M1：安装目录用 --install-dir，避免与容器命令自身的 --dir 冲突
  const dirOverride = parseInstallDirArg(tail);
  const dir = await findProductionDir(dirOverride, Deno.cwd());
  // CLI 自身的选项（--dir/--dry-run）不得进入容器命令，否则会被
  // 容器内的 noj 当作未知参数而报错。
  const cleaned = stripCliOwnedFlags(match.args);
  return await runInContainer({
    dir,
    service: match.service,
    command: cleaned,
    dryRun,
  });
}

/** 取第一个位置参数（跳过选项及其值）。 */
export function firstPositional(
  args: string[],
  valueFlags: string[] = ["--dir", "--profile"],
): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (valueFlags.includes(arg)) {
      i++; // 跳过该选项的值
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return "";
}

/** 人类可读字节数（备份 list 展示用，#515 P6）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "K";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + "M";
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + "G";
}

/** 移除第一个位置参数（保留其余顺序与选项值）。 */
export function removeFirstPositional(
  args: string[],
  valueFlags: string[] = ["--dir", "--install-dir", "--profile"],
): string[] {
  const out: string[] = [];
  let removed = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (valueFlags.includes(arg)) {
      out.push(arg);
      const value = args[i + 1];
      if (value !== undefined) {
        out.push(value);
        i++;
      }
      continue;
    }
    if (!removed && !arg.startsWith("-")) {
      removed = true;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * 命令与 profile 的相容性门禁（T23 收敛后）。
 *
 * ## T23 的变化
 *
 * 此前有 `prod`/`stack` 两个 profile，故需要"命令属于哪个模式"的双向门禁。
 * T23 删掉 `stack` 模态后只剩**一个** profile，那些判定随之失去意义——继续保留
 * 会让一个已删除的模式以错误信息的形式"复活"（实测：`noj-cli deploy status`
 * 报的是"属于 JSON 编排模式，请改用 --profile stack"，而 stack 已不存在）。
 *
 * 现在只做一件事：**拒绝 `--profile stack`**（显式使用了已删除的模式时给出
 * 可操作提示，而不是静默忽略——静默忽略会让用户以为自己在用某个模式）。
 *
 * `--profile prod` 与不传 profile 都放行：前者是显式确认，后者是唯一模式。
 */
export function assertCommandAllowedInProfile(
  profile: ProfileName,
  command: string,
): void {
  if (profile !== "prod") {
    throw new UsageError(
      `--profile ${profile} 已不受支持：T23 起 noj-cli 收敛为单模态，` +
        `配置真相源唯一（.env.prod + docker-compose.prod.yml）。\n` +
        `  直接运行 noj-cli ${command}（可省略 --profile prod）。\n` +
        `  若目录里仍有 noj-deploy.json / noj-secrets.json，可直接删除。`,
    );
  }
}

/**
 * 剔除属于 noj-cli 自身的选项（`--dir` 及其值、`--dry-run`），
 * 使容器内的 noj 只看到它认识的参数。
 */
export function stripCliOwnedFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") continue;
    // 评审 B3：--debug 是 noj-cli 自身的排查开关，必须剥离后再转发，
    // 否则会被子命令/容器当作未知选项（help 却把它列为全局选项）。
    if (arg === "--debug") continue;
    // 评审 M1：Tier 3 命令的 --dir 存在双语义冲突——noj-cli 用它指安装目录，
    // 而容器内的 noj 用它指子命令参数（如 problems import --dir <包目录>）。
    // 因此 CLI 自身的安装目录选项改名为 --install-dir，容器侧的 --dir 原样透传。
    if (arg === "--install-dir") {
      i++;
      continue;
    }
    if (arg.startsWith("--install-dir=")) continue;
    out.push(arg);
  }
  return out;
}

/**
 * 解析 Tier 3 命令的安装目录（`--install-dir`）。
 *
 * 与 `--dir` 分开的原因见 {@link stripCliOwnedFlags}（评审 M1）。
 */
export function parseInstallDirArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--install-dir") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError("--install-dir 需要一个安装目录");
      }
      return value;
    }
    if (arg.startsWith("--install-dir=")) {
      const value = arg.slice("--install-dir=".length);
      if (value === "") throw new UsageError("--install-dir 需要一个安装目录");
      return value;
    }
  }
  return undefined;
}

/**
 * **不依赖** profile 判定的命令：纯工具/自描述命令。
 *
 * 这些命令在任意目录都应有意义（如 `version`、`problem lint`），
 * 若也要求探测成功，会让用户在普通目录下无法使用它们。
 */
export const PROFILE_AGNOSTIC = new Set([
  "version",
  "help",
  "problem",
  "problems",
  "doctor",
  "completions",
]);

/**
 * 自动探测 profile。
 *
 * **歧义或都无法识别时抛 {@link UsageError}**（#518 验收：失败必须报错，
 * 不得静默取默认值）——猜错模式会把命令作用到错误的目标。
 */
export function detectProfileOrNull(startDir?: string): ProfileName | null {
  // `--dir` 优先：它与 `--profile` 正交（issue #518），是既有的
  // 「在任意目录用 --dir 指定安装目录」逃生通道（README / 生产文档均推荐）。
  const start = startDir !== undefined
    ? resolve(Deno.cwd(), startDir)
    : Deno.cwd();
  const result = detectProfile({ start, ...realProfileFs() });
  if (result.profile === null) {
    throw new UsageError(result.error ?? "无法判定 profile");
  }
  return result.profile;
}

/** 校验 `--profile` 取值；未给出时返回 undefined（交由探测决定）。 */
export function validateProfileName(value?: string): ProfileName | undefined {
  if (value === undefined) return undefined;
  const result = detectProfile({
    explicit: value,
    start: Deno.cwd(),
    ...realProfileFs(),
  });
  if (result.profile === null) {
    throw new UsageError(result.error ?? `无效的 --profile: ${value}`);
  }
  return result.profile;
}

/**
 * 从本文件**自身的分发代码**中提取顶层命令名（防漂移门禁的事实源）。
 *
 * 提取两处既有判定，而不是另写一份字面量清单——后者会与 switch 一起漂移，
 * 正是本任务要消灭的缺陷形态：
 * 1. `dispatchCommand` 顶层 `switch (command)` 的 `case "..."` 标签
 *    （4 空格缩进；内层 switch 缩进更深，不会被命中）；
 * 2. `dispatchCommand` 内 `command === "..."` 的特判分支
 *    （`problem`/`problems`/`stack`；`backup drill` 的 `backup` 亦在此列）。
 *
 * 以 `dispatchCommand`（而非整个文件）为界，避免把 `run()` 的
 * `--help`/`-v` 等旗标误收为命令名。锚点失效时返回空集，
 * 主门禁会因声明落空而**立刻变红**，不会静默通过。
 */
function topLevelDispatchNames(): Set<string> {
  const source = Deno.readTextFileSync(new URL(import.meta.url));
  // 锚点必须**行首匹配**：本函数自身源码里含有这两个签名的字符串字面量，
  // 用普通 indexOf 会命中自己（实测 start/end 落在本函数内部，提取结果为空）。
  const startMatch = /^export async function dispatchCommand\(/m.exec(source);
  const endMatch = /^export function removedCommandNotice\(/m.exec(source);
  if (startMatch === null || endMatch === null) return new Set();
  const start = startMatch.index;
  const end = endMatch.index;
  if (end <= start) return new Set();
  const body = source.slice(start, end);
  const names = new Set<string>();
  for (const m of body.matchAll(/^ {4}case "([^"]+)":/gm)) names.add(m[1]!);
  for (const m of body.matchAll(/command === "([^"]+)"/g)) names.add(m[1]!);
  return names;
}

/**
 * dispatcher **实际可处理**的顶层命令集合（防漂移门禁的右侧）。
 *
 * 由三处既有事实源合并，**不含**本门禁自带的命令清单：
 * 1. `PRODUCTION_COMMANDS`（`production.ts` 的声明）；
 * 2. `CONTAINER_COMMANDS` 的顶层名（`container.ts` 的 Tier 3 前缀路由，
 *    由 `run()` 在进入 `dispatchCommand` 之前拦下）；
 * 3. {@link topLevelDispatchNames} 从 `dispatchCommand` 自身源码提取的名字。
 *
 * 若 help 声明了任何此处不存在的命令，`commands_test.ts` 的门禁即失败。
 */
export function dispatchableTopLevelNames(): Set<string> {
  const names = new Set<string>(PRODUCTION_COMMANDS);
  for (const prefix of CONTAINER_COMMANDS) {
    const top = prefix[0];
    if (top !== undefined) names.add(top);
  }
  for (const name of topLevelDispatchNames()) names.add(name);
  return names;
}

/**
 * 生成顶层帮助文本（唯一事实源见 {@link renderCommandList}）。
 *
 * 命令清单已收敛到 `commands.ts`；此处只做委托，不再手写命令列表。
 */
export function printHelp(): string {
  return renderCommandList();
}

/** 已登记的顶层命令（用于拼写建议，#517 E8）。 */
export const KNOWN_TOP = new Set([
  // #518/#514：新命令必须登记，否则拼写建议看不到它们。
  // T23：`doctor`/`deploy`/`maintain`/`stack`/`run-server` 已随双模态移除，
  // 因此不再登记——它们不是"可用命令"，出现在拼写建议里会误导用户。
  "problem",
  "problems",
  "version",
  ...PRODUCTION_COMMANDS,
]);

/** 解析 --port <n>，缺省 8080；非法值抛 {@link UsageError}。 */
export function parsePort(args: string[]): number {
  return parsePortArg(args, 8080);
}

export interface BackupArgs {
  sub: string;
  dir: string | undefined;
  backupDir: string | undefined;
  passphraseFile: string | undefined;
  zstdLevel: number;
  noEncrypt: boolean;
  confirm: boolean;
  includeDeployConfigs: boolean;
  snapshot: string | undefined;
  report: string | undefined;
  /** #515 P6：prune 保留最近 N 份。 */
  keep: number | undefined;
  /** #515 P6：prune 删除早于 N 天的备份。 */
  olderThanDays: number | undefined;
  /** #515 P6：prune 是否允许删除旧目录格式（默认否，防误删）。 */
  includeLegacy: boolean;
  /** #515 P6：机器可读输出（list/prune）。 */
  json: boolean;
  /** #516：跳过 Judge 验收。 */
  skipJudge: boolean;
  /** #516：演练子网。 */
  subnet: string | undefined;
  /** #516：演练 Compose 项目名。 */
  projectName: string | undefined;
  /** #516：RPO 上限（小时）。 */
  rpoMaxHours: number | undefined;
  /** #516：RTO 上限（分钟）。 */
  rtoMaxMinutes: number | undefined;
  /** #516：drill 保留演练环境（与 prune 的 --keep N 语义不同）。 */
  keepFlag: boolean;
}

/** 解析 maintain backup 参数：子命令 + 位置参数 snapshot + 各旗标。 */
export function parseBackupArgs(args: string[]): BackupArgs {
  const out: BackupArgs = {
    sub: args[0] ?? "",
    dir: undefined,
    backupDir: undefined,
    passphraseFile: undefined,
    zstdLevel: 15,
    noEncrypt: false,
    confirm: false,
    includeDeployConfigs: false,
    snapshot: undefined,
    report: undefined,
    keep: undefined,
    olderThanDays: undefined,
    includeLegacy: false,
    json: false,
    skipJudge: false,
    subnet: undefined,
    projectName: undefined,
    rpoMaxHours: undefined,
    rtoMaxMinutes: undefined,
    keepFlag: false,
  };
  const rest = args.slice(1);
  // `--dir` 统一解析（支持 `--dir=`，缺值报错）；下面的 switch 跳过它。
  out.dir = parseDirArg(rest);
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--dir" || a.startsWith("--dir=")) {
      if (a === "--dir") i++;
      continue;
    }
    const takeValue = (name: string): string => {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${name} 需要一个值`);
      }
      i++;
      return value;
    };
    switch (a) {
      case "--backup-dir":
        out.backupDir = takeValue("--backup-dir");
        break;
      case "--passphrase-file":
        out.passphraseFile = takeValue("--passphrase-file");
        break;
      case "--zstd-level": {
        const raw = takeValue("--zstd-level");
        const level = Number(raw);
        if (!Number.isInteger(level) || level < 1 || level > 22) {
          throw new UsageError(
            `--zstd-level 需要一个 1-22 的整数，收到 "${raw}"`,
          );
        }
        out.zstdLevel = level;
        break;
      }
      case "--no-encrypt":
        out.noEncrypt = true;
        break;
      case "--confirm":
        out.confirm = true;
        break;
      case "--include-deploy-configs":
        out.includeDeployConfigs = true;
        break;
      case "--report":
        out.report = takeValue("--report");
        break;
      case "--keep": {
        // 两种语义（#515/#516），按**子命令**区分而非猜测下一个参数：
        // - prune：`--keep N` 保留最近 N 份（必须有值）；
        // - drill：裸 `--keep` 保留演练环境（bool，无值）。
        if (out.sub === "drill") {
          out.keepFlag = true;
          break;
        }
        // 注意：takeValue 已经把 i 推进到值上，**不可再 i++**
        // （否则会多跳一个 token，把下一个选项的值当成位置参数）。
        const raw = takeValue("--keep");
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          throw new UsageError(`--keep 需要一个非负整数，收到 "${raw}"`);
        }
        out.keep = n;
        break;
      }
      case "--older-than": {
        const raw = takeValue("--older-than");
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          throw new UsageError(
            `--older-than 需要一个非负整数（天），收到 "${raw}"`,
          );
        }
        out.olderThanDays = n;
        break;
      }
      case "--include-legacy":
        // 旧目录格式承载存量数据，默认受保护（#515）
        out.includeLegacy = true;
        break;
      case "--skip-judge":
        // #516：无 Judge 部署时跳过相关验收
        out.skipJudge = true;
        break;
      case "--subnet":
        out.subnet = takeValue("--subnet");
        break;
      case "--project-name":
        out.projectName = takeValue("--project-name");
        break;
      case "--rpo-max-hours": {
        const raw = takeValue("--rpo-max-hours");
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          throw new UsageError(`--rpo-max-hours 需要正整数，收到 "${raw}"`);
        }
        out.rpoMaxHours = n;
        break;
      }
      case "--rto-max-minutes": {
        const raw = takeValue("--rto-max-minutes");
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          throw new UsageError(`--rto-max-minutes 需要正整数，收到 "${raw}"`);
        }
        out.rtoMaxMinutes = n;
        break;
      }
      case "--json":
        out.json = true;
        break;
      default:
        positional.push(a);
    }
  }
  out.snapshot = positional[0];
  return out;
}

/** 分发选项（#518：profile 相关行为）。 */
export interface DispatchOptions {
  /** `--profile` 显式值；缺省时由探测决定。 */
  explicitProfile?: string;
  /** 由 `stack` 委派而来：不打印旧名废弃提示。 */
  stackAlias?: boolean;
}

/**
 * 解析 profile，失败时抛出 {@link UsageError}。
 *
 * `--profile` 与 `--dir` 正交：profile 定语法，`--dir` 定位置。
 */
export function resolveProfile(
  options: DispatchOptions,
  cwd: string,
): ProfileName {
  const result = detectProfile({
    explicit: options.explicitProfile,
    start: cwd,
    ...realProfileFs(),
  });
  if (result.profile === null) {
    throw new UsageError(result.error ?? "无法判定 profile");
  }
  return result.profile;
}

/**
 * `backup drill`：解析参数并执行**真实恢复演练**。
 *
 * **T24 接线**：目录由调用方（`dispatchProduction`）给定——它已用
 * `findProductionDir` 定位过，这里不再重复探测（重复探测会在"显式 --dir 与实际
 * 安装目录不一致"时给出误导性的第二次报错）。
 */
async function runBackupDrillFromProduction(
  args: string[],
  ctx: { cwd: string; prodDir: string },
): Promise<number> {
  void ctx;
  if (wantsHelp(args)) {
    console.log(renderDrillHelp());
    return EXIT_OK;
  }
  const a = parseBackupArgs(["drill", ...args]);
  if (a.snapshot === undefined) {
    console.error(
      "backup drill: 需要 <snapshot> 路径" + "\n" +
        "  提示：drill 会起独立 Compose 项目做真实恢复（分钟级、需 Docker）；" +
        "只校验文件完整请用 backup verify。",
    );
    return EXIT_USAGE;
  }
  return await executeDrill(a, ctx.prodDir);
}

/**
 * drill 专项帮助（#516 验收：help 必须明确「分钟级、耗 Docker」，
 * 而不是只显示通用的 maintain backup 帮助）。
 *
 * **T23 更新**：快照形态说明随 T19 的裁决反转——现在只接受 `.nojbackup`
 * 单文件（唯一形态），旧的"目录快照"表述已作废。
 */
export function renderDrillHelp(): string {
  return renderCommandHelp(
    "noj-cli backup drill <snapshot> [选项]",
    [
      "在**隔离环境**中真实恢复快照并做业务验收（登录/题目读取/可选评测）。",
      "",
      "注意: 会起独立 Compose 项目（默认 noj-drill）、占用独立子网与数据卷，",
      "      耗时**分钟级**且**需要 Docker 资源**——不是随手可跑的检查。",
      "      只校验文件完整请用 `backup verify`（结构可解析加 `--deep`）。",
      "",
      "快照形态: `.nojbackup` 单文件（`backup create` 的唯一产物形态）。",
      "演练会校验其 payload_layout == prod-raw 后解包到临时目录，",
      "再交给隔离编排（独立项目/独立子网/**不映射宿主机端口**）。",
      "",
      "选项:",
      "  --skip-judge            跳过 Judge/附件/评测验收（无 Judge 部署时）",
      "  --subnet CIDR           演练网络子网（默认 172.29.0.0/16）",
      "  --project-name NAME     演练 Compose 项目名（默认 noj-drill；禁止含 prod）",
      "  --report FILE           报告路径（默认快照同级 restore-drill-report.txt）",
      "  --rpo-max-hours N       快照年龄上限（默认 24）；超限视为演练失败",
      "  --rto-max-minutes N     恢复耗时上限（默认 60）；超限视为演练失败",
      "  --keep                  保留演练环境以便排查（默认清理）",
      "  --json                  机器可读报告",
      "  --dir <path>            生产安装目录",
      "  --passphrase-file FILE  GPG 口令文件",
      "",
      "退出码: 0 通过 / 1 演练失败（含业务验收失败、超 RPO/RTO）/ 2 参数或资源错误",
    ],
  );
}

/**
 * 执行一次真实恢复演练并输出结果。
 *
 * **T23 接线**：改用 T19 的**原生**实现（`prod/drill/drill.ts`），不再经
 * `maintain/drill.ts` 的 bash 薄包装。这正是 R1 的落点——drill 路径因此
 * 零 `Deno.command("bash", …)`、零仓库脚本依赖。
 *
 * 退出码（#516 验收，T19 已实现并测试）：0 通过 / 1 演练失败（含 RPO/RTO 超标）/
 * 2 参数或资源错误。`runDrill` 内部已按此分层，这里只做输出与透传。
 */
async function executeDrill(
  a: BackupArgs,
  dir: string,
): Promise<number> {
  if (a.snapshot === undefined) {
    console.error(
      "backup drill: 需要 <snapshot> 路径\n" +
        "  提示：drill 会起独立 Compose 项目做真实恢复（分钟级、需 Docker）；" +
        "只校验文件完整请用 backup verify。",
    );
    return EXIT_USAGE;
  }
  try {
    const result = await runDrill({
      snapshotPath: a.snapshot,
      dir,
      runner: realRunner(),
      passphraseFile: a.passphraseFile,
      skipJudge: a.skipJudge,
      subnet: a.subnet,
      projectName: a.projectName,
      report: a.report,
      rpoMaxHours: a.rpoMaxHours,
      rtoMaxMinutes: a.rtoMaxMinutes,
      keep: a.keepFlag === true,
      log: (line) => {
        // `--json` 时 stdout 必须逐字节为 JSON，故人类日志改道 stderr
        if (a.json) console.error(line);
        else console.log(line);
      },
    });
    if (a.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.message);
      if (result.reportPath) console.log("报告：" + result.reportPath);
    }
    return result.exitCode;
  } catch (e) {
    // 参数/资源错误 → 用法错误（2），与演练失败（1）区分
    console.error("backup drill: " + (e as Error).message);
    return EXIT_USAGE;
  }
}

/**
 * 生产命令的原生分发（T24）。
 *
 * 职责分工：
 * - **本函数**：定位安装目录（`findProductionDir`）→ 拆 `--dir` → 分派到
 *   `prod/cli.ts` 的对应入口 → 打印人类结论、透传退出码；
 * - **`prod/`**：命令的全部语义（前置校验、compose 编排、状态机、输出通道）。
 *
 * 退出码：0 成功 / 1 运行失败 / 2 用法错误。
 * `--json` 时原生实现已把结果 JSON 写到 stdout，因此这里**不再打印结论**
 * （否则 stdout 会混入人类文字，破坏 T6 契约）。
 */
async function dispatchProduction(
  ctx: CommandContext,
  command: string,
  args: string[],
): Promise<number> {
  const parsed = parseProdArgs(args);
  let dir: string;
  try {
    dir = await findProductionDir(parsed.dir, ctx.cwd);
  } catch (e) {
    throw new ProductionDirError((e as Error).message);
  }
  const rest = parsed.rest;
  const json = hasJson(rest);
  // 人类结论统一走 stderr 或 stdout：`--json` 时走 stderr，保证 stdout 干净。
  const say = (text: string): void => {
    if (text === "") return;
    if (json) console.error(text);
    else console.log(text);
  };

  try {
    switch (command) {
      case "install": {
        const r = await runProdInstall(dir, rest, {});
        say(r.message);
        return r.exitCode;
      }
      case "check": {
        const r = await runProdCheck(dir, rest, {});
        say(r.message);
        return r.exitCode;
      }
      case "status": {
        const r = await runProdStatus(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "start": {
        const r = await runProdStart(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "stop": {
        const r = await runProdStop(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "restart": {
        const r = await runProdRestart(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "logs": {
        const r = await runProdLogs(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "update": {
        const r = await runProdUpdate(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "upgrade": {
        const r = await runProdUpdate(dir, rest, {}, true);
        say(r.error ?? "");
        return r.exitCode;
      }
      case "uninstall": {
        const r = await runProdUninstall(dir, rest, {});
        say(r.error ?? "");
        return r.exitCode;
      }
      case "verify": {
        // `verify` = 配置校验 + 镜像验签（比 `check` 多验签）。
        const r = await runProdCheck(dir, rest, {});
        say(r.message);
        return r.exitCode;
      }
      case "config": {
        // `config check` 是唯一支持的子命令（与 bash 的 `config-check` 等价）。
        const sub = positionals(rest)[0];
        if (sub !== undefined && sub !== "check") {
          console.error(`config 目前只支持 check，收到 "${sub}"`);
          return EXIT_USAGE;
        }
        const r = await runProdCheck(dir, rest, {});
        say(r.message);
        return r.exitCode;
      }
      case "backup": {
        return await dispatchProdBackup(dir, rest, json);
      }
      default: {
        console.error(`未知生产命令：${command}`);
        return EXIT_USAGE;
      }
    }
  } catch (e) {
    // 参数错误 → 2；其余（原生实现抛出的运行失败）→ 1
    if (e instanceof UsageError) {
      console.error(`${command}: ${(e as Error).message}`);
      return EXIT_USAGE;
    }
    console.error(`${command}: ${(e as Error).message}`);
    return EXIT_FAILURE;
  }
}

/** `backup` 的子命令分发（T17–T20 的原生实现）。 */
async function dispatchProdBackup(
  dir: string,
  args: string[],
  json: boolean,
): Promise<number> {
  // `drill` 需要自己的 help 文案（已在上方处理），这里只分派执行。
  const sub = args[0] ?? "";
  const rest = args.slice(1);
  const say = (text: string): void => {
    if (text === "") return;
    if (json) console.error(text);
    else console.log(text);
  };
  switch (sub) {
    case "drill":
      return await runBackupDrillFromProduction(rest, {
        cwd: Deno.cwd(),
        prodDir: dir,
      });
    case "create": {
      const created = await runBackupCreate(dir, {
        args: rest,
        deps: {},
        passphraseFile: flagValue(rest, "--passphrase-file"),
        backupDir: flagValue(rest, "--backup-dir"),
        zstdLevel: numberFlag(rest, "--zstd-level"),
        noEncrypt: hasFlag(rest, "--no-encrypt"),
      });
      if (json) {
        console.log(JSON.stringify(
          {
            path: created.path,
            sha256: created.sha256,
            sidecar: created.sidecar,
            payload_layout: created.manifest.payload_layout,
          },
          null,
          2,
        ));
      } else {
        say(`完整生产快照已创建：${created.path}`);
        say(`校验文件：${created.sidecar}`);
      }
      return EXIT_OK;
    }
    case "verify": {
      const r = await runBackupVerify(dir, rest, {});
      if (json) {
        console.log(JSON.stringify(
          {
            path: r.path,
            pass: r.pass,
            checks: r.checks,
            issues: r.issues,
          },
          null,
          2,
        ));
      } else {
        say(r.summary);
      }
      return r.pass ? EXIT_OK : EXIT_FAILURE;
    }
    case "list": {
      const r = await runBackupList(dir, rest, {});
      if (json) {
        console.log(JSON.stringify(r, null, 2));
      } else if (r.entries.length === 0) {
        say("没有可用备份");
      } else {
        for (const e of r.entries) {
          say(`${e.name}  ${formatBytes(e.bytes ?? 0)}  ${e.createdAt}`);
        }
      }
      return EXIT_OK;
    }
    case "prune": {
      const r = await runBackupPrune(dir, rest, {});
      if (json) {
        console.log(JSON.stringify(
          {
            applied: r.applied,
            deleted: r.deleted.map((p) => p),
            planned: r.plan.remove.map((e) => e.name),
            failed: r.failed.map((f) => f.path),
          },
          null,
          2,
        ));
      } else {
        // 默认 dry-run：必须明确告知"没有删任何东西"，否则用户以为已清理
        say(
          r.applied
            ? `已删除 ${r.deleted.length} 个备份`
            : `[dry-run] 将删除 ${r.plan.remove.length} 个备份（加 --confirm 才真正删除）`,
        );
        for (const e of r.plan.remove) say(`  - ${e.name}`);
      }
      return r.failed.length === 0 ? EXIT_OK : EXIT_FAILURE;
    }
    case "restore": {
      const r = await runBackupRestorePlan(dir, rest, {});
      if (json) {
        console.log(JSON.stringify(r, null, 2));
      } else {
        say(r.summary);
      }
      return r.verified ? EXIT_OK : EXIT_FAILURE;
    }
    case "schedule": {
      const r = await runBackupSchedule(dir, rest, {});
      if (json) {
        console.log(JSON.stringify(
          {
            exitCode: r.exitCode,
            message: r.message,
            block: r.block,
          },
          null,
          2,
        ));
      } else {
        say(r.message);
      }
      return r.exitCode;
    }
    default:
      console.error(
        `backup 需要子命令 create/verify/list/prune/restore/drill/schedule，` +
          `收到 "${sub}"`,
      );
      return EXIT_USAGE;
  }
}

/** 读一个数值旗标（非法值报用法错误）。 */
function numberFlag(args: string[], name: string): number | undefined {
  const raw = flagValue(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new UsageError(`${name} 必须是非负整数，收到 "${raw}"`);
  }
  return n;
}

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

  // `problem` = 题目包管理（#514）：init / lint / pack
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
    case "maintain":
    case "stack": {
      // T23：三个旧名（JSON 编排模式）随双模态一起移除，不再保留别名。
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
 * 注意本函数名是 `topLevelDispatchNames()` 的**提取锚点**（T7 防漂移门禁按
 * 行首匹配它来界定 `dispatchCommand` 的正文）。改名必须同步改那个正则，
 * 否则门禁会以"声明落空"的方式变红——那是**有意的**保护。
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

/** 生产命令的 CLI 侧帮助（不转发给底层 bash 脚本，#517 E12）。 */
function renderProductionCommandHelp(command: string): string {
  const summaries: Record<string, string> = {
    install: "生产安装（写入 .env.prod 并启动 Docker Compose 栈）",
    check: "生产环境检测（Linux/Docker/Compose/磁盘/端口）",
    start: "启动生产服务",
    stop: "停止生产服务",
    restart: "重启生产服务",
    status: "查看生产服务状态",
    logs: "查看生产服务日志",
    update: "同步部署文件、备份并升级生产服务",
    upgrade: "update 的别名",
    backup: "生产备份；子命令 create/verify/restore/drill",
    verify: "校验生产配置与镜像签名",
    config: "校验生产配置（不校验镜像签名）",
    uninstall: "卸载生产服务；--all 删除全部数据，需确认",
  };
  return renderCommandHelp(`noj-cli ${command} [选项]`, [
    summaries[command] ?? "生产命令",
    "",
    "说明:",
    "  该命令需要完整的生产安装目录（含 docker-compose.prod.yml 与",
    "  .env.prod）。使用 --dir <path> 指定，或在安装目录内执行。",
    "  --help 由 noj-cli 自己回答，不会转发给底层脚本。",
  ]);
}

// 直接执行时作为程序入口。
if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
