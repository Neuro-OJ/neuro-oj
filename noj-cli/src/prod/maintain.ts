/**
 * `noj-cli maintain`：维护模式/排空的 Tier 3 容器包装（P1d）。
 *
 * 宿主机侧只做**参数校验与帮助**，随后把 `maintain <子命令> …` 原样交给
 * `docker compose run --rm --no-deps --entrypoint /app/bin/noj core maintain …`。
 * HTTP 客户端、`--json` 单文档输出、wait 轮询与退出码都由容器内 CLI
 * （`noj-core/scripts/maintain.ts`）负责——本模块不重复实现协议的第二个版本。
 *
 * 独立成模块（而不是直接用 Tier 3 的通用透传）的三个理由：
 * 1. 子命令在宿主机就校验（`enter|status|wait|exit`），未知子命令立即得到
 *    用法错误（退出码 2），不必先起容器；
 * 2. 需要自己的帮助文案（`--json`/`--url`/`--timeout` 是容器内 CLI 的选项）；
 * 3. 固定以 `--no-deps` 执行（maintain 只访问已运行 core 的内部 API，不需要
 *    compose 拉起依赖服务）。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2 多副本约束）。
 */

import type { RunContainerOptions } from "../container_run.ts";
import { runInContainer } from "../container_run.ts";
import { UsageError } from "../util/args.ts";

/** 受支持的维护子命令（与容器内 CLI 的子命令一致）。 */
export const MAINTAIN_SUBCOMMANDS = [
  "enter",
  "status",
  "wait",
  "exit",
] as const;

/** 维护子命令类型。 */
export type MaintainSubcommand = typeof MAINTAIN_SUBCOMMANDS[number];

/** 解析后的 maintain 调用。 */
export interface MaintainCommand {
  /** 子命令。 */
  sub: MaintainSubcommand;
  /** 容器内 CLI 的完整参数（含 `maintain` 前缀）。 */
  args: string[];
  /** 是否请求机器可读 JSON（容器内 CLI 的 `--json`）。 */
  json: boolean;
}

/**
 * 解析 `maintain` 之后的参数。
 *
 * 入参形如 `["enter", "--json"]`，且**已剔除 CLI 自身选项**
 * （`--install-dir`/`--dry-run` 由 {@link dispatchMaintain} 剥离）。
 * 子命令缺失或未知抛 {@link UsageError}（退出码 2）；其余选项原样透传
 * （其契约属于容器内 CLI，本模块不复制一份白名单）。
 */
export function parseMaintainArgs(argv: string[]): MaintainCommand {
  const sub = argv.find((arg) => !arg.startsWith("-"));
  if (sub === undefined) {
    throw new UsageError(
      `maintain 需要子命令 ${MAINTAIN_SUBCOMMANDS.join("/")}`,
    );
  }
  if (!(MAINTAIN_SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new UsageError(
      `未知的 maintain 子命令：${sub}（可用 ${
        MAINTAIN_SUBCOMMANDS.join("/")
      }）`,
    );
  }
  return {
    sub: sub as MaintainSubcommand,
    args: ["maintain", ...argv],
    json: argv.includes("--json"),
  };
}

/** maintain 的专项帮助文本（容器内 CLI 的选项 + 宿主机选项）。 */
export function renderMaintainHelp(): string {
  return [
    "noj-cli maintain <enter|status|wait|exit> [选项]",
    "",
    "在 noj-server 容器内执行维护模式/排空命令（Tier 3；--no-deps 运行）。",
    "update 默认在升级前自动 enter + wait、目标栈就绪后 exit；本命令用于人工干预。",
    "",
    "子命令:",
    "  enter    进入维护模式（幂等；此后写请求返回 503 MAINTENANCE）",
    "  status   查看排空状态、blockers 与队列/在途任务",
    "  wait     轮询直到 drained（默认间隔 5s、超时 1800s）",
    "  exit     退出维护模式（幂等；恢复写请求）",
    "",
    "选项（透传给容器内 CLI）:",
    "  --json              stdout 只输出一个 JSON 文档",
    "  --url <url>         内部 API 地址（默认 NOJ_CORE_INTERNAL_URL 或 http://core:8000）",
    "  --timeout <秒>      wait 超时（默认 1800）",
    "  --interval <秒>     wait 轮询间隔（默认 5）",
    "",
    "宿主选项:",
    "  --install-dir <path>  生产安装目录（CLI 自身选项）",
    "  --dry-run             仅打印将执行的 compose 命令",
    "",
    "内部 API 需要 .env.prod 的 NOJ_INTERNAL_SERVICE_TOKEN；未设置时端点返回 503。",
    "退出码: 0 成功 / 1 运行失败 / 2 用法错误（与容器内 CLI 一致）。",
    "",
  ].join("\n");
}

/** 容器路由匹配结果的结构子集（`container.ts:ContainerCommandMatch`）。 */
export interface MaintainRouteMatch {
  /** compose service 名（`core`）。 */
  service: string;
  /** 完整顶层参数（`["maintain", …]`）。 */
  args: string[];
}

/** 宿主机侧 maintain 分发的注入点（全部可替换，单测不起容器）。 */
export interface MaintainDispatchDeps {
  /** 生产安装目录定位（复用 `cli.ts` 的 `findProductionDir`，cwd 已固化）。 */
  findProductionDir: (explicit: string | undefined) => Promise<string>;
  /** 解析 `--install-dir`（CLI 自身选项）。 */
  parseInstallDir: (args: string[]) => string | undefined;
  /** 剔除 CLI 自身选项（`--install-dir`/`--dry-run`/`--debug`）。 */
  stripCliFlags: (args: string[]) => string[];
  /** 容器执行器；缺省 {@link runInContainer}。 */
  run?: (options: RunContainerOptions) => Promise<number>;
}

/**
 * 执行 `noj-cli maintain …`：帮助 → 参数校验 → 目录定位 → 容器执行。
 *
 * `match` 是容器路由匹配到的结果（`args` 为 `["maintain", …]`）。
 * 退出码原样透传容器内 CLI 的退出码（0/1/2）。
 */
export async function dispatchMaintain(
  match: MaintainRouteMatch,
  deps: MaintainDispatchDeps,
): Promise<number> {
  const tail = match.args.slice(1);
  if (tail.includes("--help") || tail.includes("-h")) {
    console.log(renderMaintainHelp());
    return 0;
  }
  const command = parseMaintainArgs(deps.stripCliFlags(tail));
  const dir = await deps.findProductionDir(deps.parseInstallDir(tail));
  const run = deps.run ?? runInContainer;
  return await run({
    dir,
    service: match.service,
    command: command.args,
    noDeps: true,
    dryRun: tail.includes("--dry-run"),
  });
}
