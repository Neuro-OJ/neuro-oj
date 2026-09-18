import { resolve } from "@std/path";
import { findDeployDir } from "./util/find_deploy_dir.ts";
import { VERSION } from "./mod.ts";
import { realProbe } from "./doctor/probe.ts";
import { runDoctor } from "./doctor/doctor.ts";
import { formatReport } from "./doctor/report.ts";
import { realIO } from "./tui/io.ts";
import { type InitOptions, runInitWizard } from "./init/wizard.ts";
import { saveDeployment } from "./config/save.ts";
import { loadDeployment } from "./config/load.ts";
import {
  deployDown,
  deployRestart,
  deployStatus,
  deployUp,
} from "./deploy/deploy.ts";
import { maintainLogs, parseModulesArg } from "./maintain/logs.ts";
import { COLOR_MODES, type ColorMode, parseColorMode } from "./util/color.ts";
import {
  configCheck,
  configSet,
  configShow,
  maintainVerify,
} from "./maintain/config.ts";
import {
  backupCreate,
  backupDrill,
  backupRestore,
  backupVerify,
} from "./maintain/backup.ts";
import { maintainReset } from "./maintain/reset.ts";
import { listBackups, pruneBackups } from "./maintain/backup_list.ts";
import { defaultBackupDir } from "./maintain/backup.ts";
import { loadDeployConfig } from "./config/load.ts";
import { realDriver } from "./maintain/backup_driver.ts";
import { runServerForeground } from "./runtime/process.ts";
import {
  findProductionDir,
  PRODUCTION_COMMANDS,
  ProductionDirError,
  runProduction,
} from "./production.ts";
import { renderCommandHelp, renderHelp } from "./help.ts";
import { nonInteractiveAdvice } from "./init/non_interactive.ts";
import {
  parseDirArg,
  parsePortArg,
  suggestCommand,
  UsageError,
  validatePort,
} from "./util/args.ts";
import { parseContainerCommand } from "./container.ts";
import { parseProblemArgs, runProblem } from "./problem/command.ts";
import { renderProblemHelp } from "./problem/help.ts";
import { runInContainer } from "./container_run.ts";
import { detectProfile, type ProfileName, realProfileFs } from "./profile.ts";

/** CLI 执行上下文，供各子命令共享。 */
export interface CommandContext {
  cwd: string;
  /** 向上查找到的部署目录，找不到为 null。 */
  deployDir: string | null;
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
    const effectiveProfile = profileAgnostic
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
    // Tier 3 容器命令（需要在生产安装目录内执行）
    const container = parseContainerCommand([topCommand, ...topRest]);

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

    const ctx: CommandContext = {
      cwd: Deno.cwd(),
      deployDir: findDeployDir(),
    };
    return await dispatchCommand(topCommand, topRest, ctx, {
      explicitProfile,
    });
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
 * 校验命令是否属于该 profile 的集合（评审 B3）。
 *
 * 这是「`--profile` 显式生效」的落地方式：显式指定 profile 后，
 * 命令必须与之相容，否则说明用户搞混了两套模式——早失败、给可操作提示。
 */
export function assertCommandAllowedInProfile(
  profile: ProfileName,
  command: string,
): void {
  const PROD_ONLY = new Set([...PRODUCTION_COMMANDS]);
  // Tier 3 容器命令需要**生产安装目录**（docker-compose.prod.yml + .env.prod），
  // 因此属 prod 侧。早先误把它们归 stack，导致方向写反：
  // `--profile prod db migrate` 被拒、`--profile stack db migrate` 反而放行。
  // 这里登记**会路由进 Tier 3 容器的顶层命令名**。
  //
  // `problem` 与 `problems` 都要列：canonical 名是单数（#514 决策），
  // 两个名字都能到达 build/import（见 container.ts 的 CONTAINER_COMMANDS）。
  // 调用点**只在容器匹配成立时**才施加本门禁，因此 `problem lint` 这类
  // 本地出题用法不会被误拒（评审 B1/B5）。
  const TIER3 = new Set([
    "db",
    "init",
    "bootstrap",
    "problem",
    "problems",
    "search",
  ]);
  const STACK_ONLY = new Set([
    "stack",
    "deploy",
    "maintain",
    "run-server",
  ]);
  if (profile === "stack" && (PROD_ONLY.has(command) || TIER3.has(command))) {
    throw new UsageError(
      `${command} 属于生产模式（.env.prod），与 --profile stack 不符。
` +
        "请改用 --profile prod，或使用 stack 对应命令。",
    );
  }
  if (profile === "prod" && STACK_ONLY.has(command)) {
    throw new UsageError(
      `${command} 属于 JSON 编排模式（noj-deploy.json），与 --profile prod 不符。
` +
        "请改用 --profile stack，或使用生产模式对应命令。",
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

/** 生成顶层帮助文本（等价于 {@link renderHelp}，保留旧导出名）。 */
export function printHelp(): string {
  return renderHelp();
}

/** 已登记的顶层命令（用于拼写建议，#517 E8）。 */
export const KNOWN_TOP = new Set([
  "doctor",
  "deploy",
  "maintain",
  // #518/#514：新命令必须登记，否则拼写建议看不到它们
  "stack",
  "problem",
  "problems",
  "run-server",
  "version",
  ...PRODUCTION_COMMANDS,
]);

/** 解析 --port <n>，缺省 8080；非法值抛 {@link UsageError}。 */
export function parsePort(args: string[]): number {
  return parsePortArg(args, 8080);
}

/** 解析 deploy init 选项：--mode dev|prod、--port <n>、--dir <path>。 */
export function parseInitOptions(args: string[], cwd: string): InitOptions {
  let mode: "dev" | "prod" | undefined;
  let port: number | undefined;

  const modeIdx = args.indexOf("--mode");
  if (modeIdx !== -1) {
    const raw = args[modeIdx + 1];
    if (raw !== "dev" && raw !== "prod") {
      throw new UsageError(
        `--mode 仅支持 dev/prod，收到 "${raw ?? ""}"`,
      );
    }
    mode = raw;
  }
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1) {
    port = validatePort(args[portIdx + 1]);
  }

  return { mode, port, installDir: parseDirArg(args) ?? cwd };
}

/** 解析 deploy 生命周期参数：目前仅 --dir <path>。 */
export function parseDeployArgs(args: string[]): { dir: string | undefined } {
  return { dir: parseDirArg(args) };
}

/**
 * 解析 maintain 参数：`--dir <path>`、`--follow`、`--color[=]<auto|always|never>`、
 * 位置参数 modules。
 */
export function parseMaintainArgs(args: string[]): {
  dir: string | undefined;
  follow: boolean;
  color: ColorMode;
  modules: string | undefined;
} {
  const dir = parseDirArg(args);
  let follow = false;
  let color: ColorMode = "auto";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dir" || a.startsWith("--dir=")) {
      // 已由 parseDirArg 统一消费（含缺值报错），此处跳过其值
      if (a === "--dir") i++;
      continue;
    }
    if (a === "--follow") {
      follow = true;
    } else if (a === "--color") {
      // 支持 `--color always` 与 `--color=always` 两种写法。
      //
      // 只在该值**确实是合法颜色模式**时才消费下一个参数（评审 P2）：
      // 早先对任意非 `-` 开头的参数都当作颜色值，于是 `--color server`
      // 会把模块名 `server` 吞掉（`modules` 变成 undefined），
      // `maintain logs --color server` 因此丢失目标服务。
      const next = args[i + 1];
      if (
        next !== undefined &&
        // COLOR_MODES 是 readonly ColorMode[]；这里比对的是任意用户输入字符串，
        // 故先放宽为 string[]（否则 TS2345）。单一事实源仍在 COLOR_MODES。
        (COLOR_MODES as readonly string[]).includes(next.trim().toLowerCase())
      ) {
        color = parseColorMode(next);
        i++;
      } else {
        // 裸 `--color` 或后跟非法值：视为强制开（与常见 CLI 约定一致），
        // 非法值不报错也不吞参，交由位置参数处理。
        color = "always";
      }
    } else if (a.startsWith("--color=")) {
      color = parseColorMode(a.slice("--color=".length));
    } else {
      positional.push(a);
    }
  }
  return { dir, follow, color, modules: positional[0] };
}

/** maintain backup 参数解析结果。 */
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

/** 解析出部署目录；未找到返回 null（调用方负责报错文案）。 */
function resolveDeployDir(
  dirOverride: string | undefined,
  ctx: CommandContext,
): string | null {
  return dirOverride ?? ctx.deployDir ?? findDeployDir(ctx.cwd);
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

/** 将命令分发到对应处理函数。供测试与 run 共用。 */
export async function dispatchCommand(
  command: string,
  args: string[],
  ctx: CommandContext,
  options: DispatchOptions = {},
): Promise<number> {
  // 生产命令的 help 由 CLI 自己回答，不转发给 bash（#517 E12）
  if (PRODUCTION_COMMANDS.has(command) && wantsHelp(args)) {
    console.log(renderProductionCommandHelp(command));
    return EXIT_OK;
  }
  if (PRODUCTION_COMMANDS.has(command)) {
    return await runProduction(command, args);
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
  if (command === "stack") {
    // 子命令是第一个非选项参数，且不是某个选项的值
    // （`stack --dir X status` 必须识别出 status，而不是把 X 当子命令）
    const sub = firstPositional(args);
    if (wantsHelp(args) || args.length === 0) {
      console.log(renderCommandHelp("noj-cli stack <子命令> [选项]", [
        "JSON 编排模式的部署与运维（原 deploy + maintain 合并）。",
        "",
        "子命令:",
        "  init | up | down | restart | status     部署生命周期",
        "  logs | config | verify | reset          运维",
        "  backup                                  备份（create/verify/restore/drill）",
        "",
        "选项:",
        "  --dir <path>   部署目录",
        "",
        "提示: deploy / maintain 作为别名仍可用，并会打印废弃提示。",
      ]));
      return wantsHelp(args) ? EXIT_OK : EXIT_USAGE;
    }
    // 生命周期类交由 deploy 分支处理，运维类交由 maintain 分支处理。
    // 通过 stackAlias 标记跳过废弃提示（提示只针对直接使用旧名的调用方）。
    const DEPLOY_SUBS = new Set(["init", "up", "down", "restart", "status"]);
    const target = DEPLOY_SUBS.has(sub) ? "deploy" : "maintain";
    // 评审 B1：必须把**子命令置于首位**再委派，否则下游 `args[0]` 会把
    // `--dir` 当成子命令（`stack --dir X status` 曾因此丢失 status 与 --dir）。
    const delegated = [sub, ...removeFirstPositional(args)];
    return await dispatchCommand(target, delegated, ctx, {
      ...options,
      stackAlias: true,
    });
  }

  switch (command) {
    case "version":
      console.log(`noj-cli ${VERSION}`);
      return EXIT_OK;
    case "doctor": {
      if (wantsHelp(args)) {
        console.log(
          renderCommandHelp("noj-cli doctor [--port <n>] [--dir <path>]", [
            "环境检测：Docker / Compose / 磁盘 / 内存 / 端口占用。",
            "",
            "选项:",
            "  --port <n>     检测该端口是否被占用（默认 8080）",
            "  --dir <path>   部署目录（默认当前目录及祖先）",
          ]),
        );
        return EXIT_OK;
      }
      const port = parsePort(args);
      const dirOverride = parseDirArg(args);
      const installDir = dirOverride ?? ctx.deployDir ?? ctx.cwd;
      const report = await runDoctor(realProbe(), { port, installDir });
      console.log(formatReport(report));
      return report.failed ? EXIT_FAILURE : EXIT_OK;
    }
    case "deploy": {
      const sub = args[0] ?? "";
      if (!options.stackAlias && !wantsHelp(args)) {
        console.error(deprecationNotice("deploy", sub));
      }
      // `deploy <sub> --help` 必须只读：绝不能进入 init 向导（#517 E2）
      if (wantsHelp(args.slice(1)) || sub === "--help" || sub === "-h") {
        console.log(renderDeployHelp(sub));
        return EXIT_OK;
      }
      if (sub === "init") {
        const opts = parseInitOptions(args.slice(1), ctx.cwd);
        // 非 TTY 时一律拒绝进入交互向导（#517 E10）。
        //
        // 评审修正：早先这里有 `--yes` 逃生阀，但它并非已实现的非交互模式——
        // 向导仍逐个提问，读不到输入时无限循环刷屏（实测 10 秒 237 万行），
        // 比修复前更糟，且与 nonInteractiveAdvice 推荐的命令自相矛盾。
        // 因此移除该逃生阀：要么补齐真正的非交互路径，要么明确拒绝。
        const isTty = Deno.stdin.isTerminal();
        const advice = nonInteractiveAdvice(isTty, opts.mode !== undefined);
        if (advice) {
          console.error(`deploy init: ${advice.message}`);
          return EXIT_USAGE;
        }
        const { config, secrets } = await runInitWizard(
          realIO(),
          realProbe(),
          opts,
        );
        await saveDeployment(opts.installDir, config, secrets);
        console.log(
          `已写入 ${opts.installDir}/noj-deploy.json 与 noj-secrets.json`,
        );
        return EXIT_OK;
      }
      const { dir } = parseDeployArgs(args.slice(1));
      const deployDir = resolveDeployDir(dir, ctx);
      if (deployDir === null) {
        console.error("deploy: 未找到 noj-deploy.json，请先运行 deploy init");
        return EXIT_FAILURE;
      }
      switch (sub) {
        case "up": {
          const state = await deployUp({ dir: deployDir });
          console.log(`deploy up 完成，状态: ${state}`);
          return EXIT_OK;
        }
        case "down": {
          const state = await deployDown({ dir: deployDir });
          console.log(`deploy down 完成，状态: ${state}`);
          return EXIT_OK;
        }
        case "restart": {
          const state = await deployRestart({ dir: deployDir });
          console.log(`deploy restart 完成，状态: ${state}`);
          return EXIT_OK;
        }
        case "status": {
          const report = await deployStatus({ dir: deployDir });
          console.log(`状态: ${report.state}`);
          for (const c of report.components) {
            console.log(
              `  ${c.component}: ${
                c.enabled ? (c.running ? "运行中" : "未运行") : "禁用"
              } (${c.method})`,
            );
          }
          return EXIT_OK;
        }
        default:
          console.error("deploy: 需要子命令 init/up/down/restart/status");
          console.error("运行 'noj-cli deploy --help' 查看用法。");
          return EXIT_USAGE;
      }
    }
    case "maintain": {
      const sub = args[0] ?? "";
      if (!options.stackAlias && !wantsHelp(args)) {
        console.error(deprecationNotice("maintain", sub));
      }
      if (wantsHelp(args.slice(1)) || sub === "--help" || sub === "-h") {
        console.log(renderMaintainHelp(sub));
        return EXIT_OK;
      }
      if (sub === "restore") {
        return await dispatchCommand("maintain", [
          "backup",
          "restore",
          ...args.slice(1),
        ], ctx);
      }
      if (sub === "logs") {
        const { dir, follow, color, modules } = parseMaintainArgs(
          args.slice(1),
        );
        const deployDir = resolveDeployDir(dir, ctx);
        if (deployDir === null) {
          console.error(
            "maintain logs: 未找到 noj-deploy.json，请先运行 deploy init",
          );
          return EXIT_FAILURE;
        }
        try {
          const { config } = await loadDeployment(deployDir);
          const mods = parseModulesArg(modules, config);
          await maintainLogs({
            dir: deployDir,
            modules: mods,
            follow,
            color,
          });
          return EXIT_OK;
        } catch (e) {
          console.error(`maintain logs: ${(e as Error).message}`);
          return EXIT_FAILURE;
        }
      }
      if (sub === "config") {
        const rest = args.slice(1);
        const dirOverride = parseDirArg(rest);
        // 按 **`--dir` 语法**跳过（而非值相等比较）：早先用 `a !== dirOverride`
        // 会误删与目录同名的业务参数，例如
        // `config set DATA_DIR /tmp/x --dir /tmp/x` 会丢掉 `/tmp/x`。
        const positional: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i]!;
          if (a === "--dir") {
            i++; // 连同值跳过
            continue;
          }
          if (a.startsWith("--dir=")) continue;
          positional.push(a);
        }
        const action = positional[0] ?? "";
        const deployDir = resolveDeployDir(dirOverride, ctx);
        if (deployDir === null) {
          console.error(
            "maintain config: 未找到 noj-deploy.json，请先运行 deploy init",
          );
          return EXIT_FAILURE;
        }
        try {
          switch (action) {
            case "check": {
              const issues = await configCheck(deployDir);
              if (issues.length === 0) {
                console.log("配置校验通过");
                return EXIT_OK;
              }
              for (const i of issues) {
                console.error(`  ${i.path}: ${i.message}`);
              }
              return EXIT_FAILURE;
            }
            case "show": {
              console.log(await configShow(deployDir));
              return EXIT_OK;
            }
            case "set": {
              const key = positional[1];
              const value = positional[2];
              if (key === undefined || value === undefined) {
                console.error("maintain config set: 需要 <key> <value>");
                return EXIT_USAGE;
              }
              await configSet(deployDir, key, value);
              console.log(`已更新 ${key} = ${value}`);
              return EXIT_OK;
            }
            default:
              console.error("maintain config: 需要子命令 check/show/set");
              return EXIT_USAGE;
          }
        } catch (e) {
          console.error(`maintain config: ${(e as Error).message}`);
          return EXIT_FAILURE;
        }
      }
      if (sub === "backup") {
        const a = parseBackupArgs(args.slice(1));
        const deployDir = resolveDeployDir(a.dir, ctx);
        if (deployDir === null) {
          console.error("maintain backup: 未找到 noj-deploy.json");
          return EXIT_FAILURE;
        }
        try {
          switch (a.sub) {
            case "create": {
              const r = await backupCreate({
                dir: deployDir,
                backupDir: a.backupDir,
                passphraseFile: a.passphraseFile,
                zstdLevel: a.zstdLevel,
                noEncrypt: a.noEncrypt,
                driver: realDriver(),
              });
              console.log(`备份完成: ${r.path}`);
              console.log(`SHA-256: ${r.sha256}`);
              return EXIT_OK;
            }
            case "verify": {
              if (a.snapshot === undefined) {
                console.error("maintain backup verify: 需要 <snapshot> 路径");
                return EXIT_USAGE;
              }
              const report = await backupVerify({
                snapshotPath: a.snapshot,
                passphraseFile: a.passphraseFile,
                driver: realDriver(),
              });
              if (report.pass) {
                console.log("校验通过");
                return EXIT_OK;
              }
              for (const e of report.errors) console.error(`  ${e}`);
              return EXIT_FAILURE;
            }
            case "restore": {
              if (a.snapshot === undefined) {
                console.error("maintain backup restore: 需要 <snapshot> 路径");
                return EXIT_USAGE;
              }
              const state = await backupRestore({
                dir: deployDir,
                snapshotPath: a.snapshot,
                confirm: a.confirm,
                passphraseFile: a.passphraseFile,
                includeDeployConfigs: a.includeDeployConfigs,
                driver: realDriver(),
              });
              console.log(`恢复完成，状态: ${state}`);
              return EXIT_OK;
            }
            case "drill": {
              if (a.snapshot === undefined) {
                console.error("maintain backup drill: 需要 <snapshot> 路径");
                return EXIT_USAGE;
              }
              const report = await backupDrill({
                snapshotPath: a.snapshot,
                passphraseFile: a.passphraseFile,
                report: a.report,
                driver: realDriver(),
              });
              console.log(
                `演练完成（drill）：${report.pass ? "通过" : "失败"}`,
              );
              return report.pass ? EXIT_OK : EXIT_FAILURE;
            }
            case "list": {
              // #515 P6：列举备份（无需解包；识别单文件与旧目录两种格式）
              const cfg = await loadDeployConfig(deployDir);
              const backupDir = a.backupDir ?? defaultBackupDir(cfg);
              const { entries, ignored } = await listBackups(backupDir);
              if (a.json) {
                console.log(
                  JSON.stringify({ backupDir, entries, ignored }, null, 2),
                );
                return EXIT_OK;
              }
              if (entries.length === 0) {
                console.log("没有备份：" + backupDir);
                return EXIT_OK;
              }
              console.log("备份目录：" + backupDir);
              console.log("  时间                 大小      格式     名称");
              for (const e of entries) {
                const size = formatBytes(e.bytes ?? 0);
                console.log(
                  "  " + e.createdAt.padEnd(20) + " " + size.padStart(9) +
                    "  " + e.format.padEnd(7) + " " + e.name,
                );
              }
              if (ignored.length > 0) {
                console.log("  （忽略 " + ignored.length + " 个非备份条目）");
              }
              return EXIT_OK;
            }
            case "prune": {
              // #515 P6：**默认 dry-run**，--confirm 才真删
              const cfg = await loadDeployConfig(deployDir);
              const backupDir = a.backupDir ?? defaultBackupDir(cfg);
              const result = await pruneBackups(backupDir, {
                keep: a.keep,
                olderThanDays: a.olderThanDays,
                includeLegacy: a.includeLegacy,
                confirm: a.confirm,
              });
              if (a.json) {
                console.log(JSON.stringify(
                  {
                    backupDir,
                    dryRun: !a.confirm,
                    remove: result.plan.remove.map((e) => e.name),
                    keep: result.plan.keep.map((e) => e.name),
                    deleted: result.deleted,
                    failed: result.failed,
                  },
                  null,
                  2,
                ));
                // --json 也必须反映失败（此前无 failed 字段且恒 exit 0）
                return result.failed.length > 0 ? EXIT_FAILURE : EXIT_OK;
              }
              if (result.plan.remove.length === 0) {
                console.log("没有需要清理的备份。");
                return EXIT_OK;
              }
              console.log(
                a.confirm
                  ? "已删除 " + result.deleted.length + " 个备份："
                  : "（dry-run）将删除 " + result.plan.remove.length +
                    " 个备份：",
              );
              for (const e of result.plan.remove) console.log("  - " + e.name);
              // 删除失败必须上报且影响退出码（此前 CLI 层忽略了 failed[]，
              // 只打印「已删除 0 个」却 exit 0 —— 假成功）。
              if (result.failed.length > 0) {
                console.error(`失败 ${result.failed.length} 个（未删除）：`);
                for (const f of result.failed) {
                  console.error(`  ! ${f.path}: ${f.reason}`);
                }
                return EXIT_FAILURE;
              }
              if (!a.confirm) console.log("加 --confirm 才会真正删除。");
              return EXIT_OK;
            }
            default:
              console.error(
                "maintain backup: 需要子命令 create/verify/restore/drill/list/prune",
              );
              return EXIT_USAGE;
          }
        } catch (e) {
          console.error(`maintain backup: ${(e as Error).message}`);
          return EXIT_FAILURE;
        }
      }

      if (sub === "reset") {
        const a = parseBackupArgs(["reset", ...args.slice(1)]);
        const deployDir = resolveDeployDir(a.dir, ctx);
        if (deployDir === null) {
          console.error("maintain reset: 未找到 noj-deploy.json");
          return EXIT_FAILURE;
        }
        try {
          const state = await maintainReset({
            dir: deployDir,
            confirm: a.confirm,
            includeDeployConfigs: a.includeDeployConfigs,
            driver: realDriver(),
          });
          console.log(`重置完成，状态: ${state}`);
          return EXIT_OK;
        } catch (e) {
          console.error(`maintain reset: ${(e as Error).message}`);
          return EXIT_FAILURE;
        }
      }

      if (sub === "verify") {
        const dirOverride = parseDirArg(args.slice(1));
        const deployDir = resolveDeployDir(dirOverride, ctx);
        if (deployDir === null) {
          console.error("maintain verify: 未找到 noj-deploy.json");
          return EXIT_FAILURE;
        }
        try {
          const report = await maintainVerify(deployDir);
          if (report.pass) {
            console.log("校验通过");
            return EXIT_OK;
          }
          for (const e of report.errors) console.error(`  ${e}`);
          return EXIT_FAILURE;
        } catch (e) {
          console.error(`maintain verify: ${(e as Error).message}`);
          return EXIT_FAILURE;
        }
      }

      console.error(
        "maintain: 需要子命令 logs/backup/restore/verify/reset/config",
      );
      console.error("运行 'noj-cli maintain --help' 查看用法。");
      return EXIT_USAGE;
    }
    case "run-server": {
      if (wantsHelp(args)) {
        console.log(renderCommandHelp("noj-cli run-server [--dir <path>]", [
          "前台运行 noj-server 二进制（阻塞当前终端）。",
          "",
          "选项:",
          "  --dir <path>   部署目录（默认当前目录及祖先）",
        ]));
        return EXIT_OK;
      }
      const dirOverride = parseDirArg(args);
      const deployDir = resolveDeployDir(dirOverride, ctx);
      if (deployDir === null) {
        console.error("run-server: 未找到 noj-deploy.json");
        return EXIT_FAILURE;
      }
      return await runServerForeground({ dir: deployDir });
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
 * 执行旧名（`deploy`/`maintain`）并打印废弃提示。
 *
 * 迁移策略（#518）：**先做加法、后做改名**。旧名保留为别名至少一个版本周期，
 * 因此这里只提示、不阻断。`--help` 不打印提示，避免污染帮助输出。
 */
export function deprecationNotice(
  legacy: string,
  sub: string,
): string {
  const suffix = sub === "" ? "" : " " + sub;
  return "提示: " + legacy + " 已合并为 stack；请改用 noj-cli stack" + suffix +
    "。旧名将在后续版本移除。";
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
    "  该命令需要完整的生产安装目录（含 scripts/deploy/production.sh 与",
    "  docker-compose.prod.yml）。使用 --dir <path> 指定，或在安装目录内执行。",
    "  --help 由 noj-cli 自己回答，不会转发给底层脚本。",
  ]);
}

/** deploy 子命令帮助。 */
function renderDeployHelp(sub: string): string {
  if (sub === "init") {
    return renderCommandHelp("noj-cli deploy init [选项]", [
      "交互式生成 noj-deploy.json 与 noj-secrets.json。",
      "",
      "选项:",
      "  --mode dev|prod      部署模式",
      "  --port <n>           服务端口（1-65535）",
      "  --dir <path>         安装目录（默认当前目录）",
      "",
      "提示: --help 只读，不会创建任何文件。",
    ]);
  }
  return renderCommandHelp("noj-cli deploy <子命令> [选项]", [
    "JSON 编排模式的部署生命周期。",
    "",
    "子命令:",
    "  init                  交互式初始化配置",
    "  up                    启动服务",
    "  down                  停止服务",
    "  restart               重启服务",
    "  status                查看状态",
    "",
    "选项:",
    "  --dir <path>          部署目录（默认当前目录及祖先）",
  ]);
}

/** maintain 子命令帮助。 */
function renderMaintainHelp(sub: string): string {
  if (sub === "backup") {
    return renderCommandHelp("noj-cli maintain backup <子命令> [选项]", [
      "JSON 编排模式的备份运维。",
      "",
      "子命令:",
      "  create                创建备份",
      "  verify <snapshot>     校验备份完整性",
      "  restore <snapshot>    恢复备份（需 --confirm）",
      "  drill <snapshot>      恢复演练",
      "",
      "选项:",
      "  --dir <path>          部署目录",
      "  --backup-dir <path>   备份输出目录",
      "  --passphrase-file <p> 口令文件",
      "  --zstd-level <n>      压缩级别（1-22，默认 15）",
      "  --no-encrypt          不加密（需显式指定）",
      "  --confirm             确认危险操作",
    ]);
  }
  return renderCommandHelp("noj-cli maintain <子命令> [选项]", [
    "JSON 编排模式的运维命令。",
    "",
    "子命令:",
    "  logs                  查看日志（--follow / --color）",
    "  config check|show|set 配置校验与查看",
    "  verify                配置校验",
    "  reset                 重置部署（需 --confirm）",
    "  backup                备份（create/verify/restore/drill）",
    "  restore               等价于 backup restore",
  ]);
}

// 直接执行时作为程序入口。
if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
