// uninstall 命令族：确认词闸门、依赖检查、compose down、PATH 软链清理与安装目录删除。

import { emitHuman, emitJson } from "../../output/render.ts";
import type { StatusKind } from "../../output/theme.ts";
import type { ComposeOptions } from "../compose.ts";
import { PROD_SERVICES } from "../compose.ts";
import {
  assertRemovableInstallDir,
  checkUninstallDependencies,
  composeOutputText,
  removeInstallDirectory,
  runComposeSub,
} from "./steps.ts";
import { unregisterCommand } from "./path.ts";
import { failed, lifecycleContext } from "./context.ts";
import type { LifecycleBaseResult, LifecycleOptions } from "./services.ts";
import type { LifecycleContext } from "./context.ts";

/** `uninstall` 的注入点。 */

export interface UninstallOptions extends LifecycleOptions {
  /** `--yes`：跳过确认提示（自动化环境唯一合法路径）。 */
  yes?: boolean;
  /** `--all`：删除数据卷与安装目录（默认只删容器/网络/本地镜像）。 */
  all?: boolean;
  /**
   * 交互确认读取（`read_prompt` 的注入点）。
   *
   * 缺省不读真实 stdin：仅在 `isTty` 为真时由调用方（CLI 层）接上 `PromptIO`。
   * 未注入且需要确认时按"无法读取确认"处理——绝不静默放行破坏性操作。
   */
  readConfirm?: (prompt: string) => Promise<string>;
  /** 覆盖**挂载**的 docker 可执行名（`NOJ_DEPLOY_DOCKER_BIN`）。 */
  dockerBin?: string;
  /** 全局命令目录（`NOJ_BIN_DIR`）；缺省 `/usr/local/bin`。 */
  binDir?: string;
  /** 用户 home；缺省进程环境 `HOME`。 */
  userHome?: string;
  /**
   * 进程环境快照；缺省 `Deno.env.toObject()`（与 install 的 `processEnv` 同义）。
   *
   * 命名刻意**不叫 `env`**：`PreparedEnvironment.env` 指 `.env.prod` 解析出的
   * 键值集合，两者概念相反（进程环境 vs 配置文件），同名会被读成同一件事
   * （T15 评审 Minor 6）。
   */
  processEnv?: Record<string, string>;
  /** 显示传入的终端判定；缺省 `Deno.stdin.isTerminal()`。 */
  isTty?: boolean;
  /** 安装版 CLI 路径（`--all` 的安装完整性守卫；缺省 `<dir>/bin/noj-cli`）。 */
  cliBinary?: string;
}

/** {@link uninstall} 的结果（在公共形状上追加删除范围）。 */
export interface UninstallResult extends LifecycleBaseResult {
  /** 是否 `--all`（删除数据卷与安装目录）。 */
  all: boolean;
  /**
   * `down --volumes` 是否**确实执行成功**（即数据卷删除这一步的结果）。
   *
   * 只反映第 4 步（`compose down`）的结果，**不受**后续清理影响：软链清理
   * （第 5 步）或删目录（第 6 步）失败时本字段仍为 `true`——数据卷已经删了，
   * 如实报告才便于自动化判定"是否已不可恢复"（T15 评审 Minor 4）。
   * 成功路径恒等于 `all`（默认卸载不带 `--volumes`）。
   */
  volumesRemoved: boolean;
  /** 实际移除的 PATH 软链（只含指向本安装目录者）。 */
  removedCommands: string[];
  /** 是否已删除安装目录。 */
  installDirRemoved: boolean;
}

/** 确认提示（逐字对照 deploy.sh:1068/:1079 的 `read_prompt` 文案）。 */
export const UNINSTALL_PROMPT = "请输入 UNINSTALL 确认卸载（其他输入取消）：";
/** `--all` 的确认提示（**不同**于默认卸载）。 */
export const UNINSTALL_ALL_PROMPT =
  "请输入 DELETE ALL 确认完全删除（其他输入取消）：";

/** `--all` 的警告正文（deploy.sh:1060-1067 逐字）。 */
export const UNINSTALL_ALL_WARNING = [
  "警告：即将完全删除 NOJ：",
  "  - 删除当前 Compose 栈的容器、网络、本地镜像和全部数据卷",
  "  - 删除当前安装目录中的配置、备份和部署文件",
  "  - 删除指向当前安装目录的 PATH 命令软链接",
  "  - 不修改宿主机 Nginx/Caddy/宝塔站点、证书或其他容器",
  "此操作不可恢复，请先确认备份已经下载到其他位置。",
].join("\n");

/** 默认卸载的说明正文（deploy.sh:1072-1078 逐字）。 */
export const UNINSTALL_WARNING = [
  "即将卸载 NOJ 生产服务：",
  "  - 删除当前 Compose 栈的容器、网络和本地镜像",
  "  - 保留 PostgreSQL、Redis、MinIO、题目包和 Judge 缓存数据卷",
  "  - 保留 .env.prod、备份和部署目录",
  "  - 不修改宿主机 Nginx/Caddy/宝塔站点、证书或其他容器",
].join("\n");

/** 无 TTY 且未 `--yes` 的硬错误文案（deploy.sh:1057-1058 逐字）。 */
export const UNINSTALL_TTY_HINT =
  "卸载需要交互确认；自动化环境请显式使用 --yes";

/** 默认卸载取消文案（deploy.sh:1081 逐字）。 */
export const UNINSTALL_CANCELLED_HINT = "未确认卸载，未修改任何服务或文件";
/** `--all` 取消文案（deploy.sh:1070 逐字）。 */
export const UNINSTALL_ALL_CANCELLED_HINT =
  "未确认完全删除，未修改任何服务或文件";

/**
 * `confirm_uninstall`（deploy.sh:1052-1084）：确认词闸门。
 *
 * **成功返回 `null`，失败返回面向用户的文案**（错误已经在人类通道写出）：
 * 两种确认词与"无 TTY"三种拒绝理由的文案各不同，调用方只需转退出码。
 * 本函数**零副作用**——不调用 runner、不写文件，只写提示与读一次输入。
 */
async function confirmUninstall(
  ctx: LifecycleContext,
  opts: UninstallOptions,
): Promise<string | null> {
  if (opts.yes === true) return null;

  if (!(opts.isTty ?? Deno.stdin.isTerminal())) {
    return UNINSTALL_TTY_HINT;
  }

  if (opts.all === true) {
    ctx.error(UNINSTALL_ALL_WARNING);
    const answer = await readConfirm(opts, UNINSTALL_ALL_PROMPT, ctx);
    if (answer === null) return "无法读取确认输入";
    return answer === "DELETE ALL" ? null : UNINSTALL_ALL_CANCELLED_HINT;
  }

  ctx.error(UNINSTALL_WARNING);
  const answer = await readConfirm(opts, UNINSTALL_PROMPT, ctx);
  if (answer === null) return "无法读取确认输入";
  return answer === "UNINSTALL" ? null : UNINSTALL_CANCELLED_HINT;
}

/** 读一行确认；未注入读取器时返回 null（绝不静默放行）。 */
async function readConfirm(
  opts: UninstallOptions,
  prompt: string,
  ctx: LifecycleContext,
): Promise<string | null> {
  if (opts.readConfirm === undefined) {
    ctx.error(prompt);
    return null;
  }
  return await opts.readConfirm(prompt);
}

/**
 * `uninstall`（deploy.sh:1097-1111）：确认 → 前置 → compose down → 软链清理 → 删目录。
 *
 * 退出码：0 成功；1 运行失败（确认不符、前置不过、compose 失败、工作区拒绝、
 * 目录删除失败）；用法错误 2 由 CLI 解析层产出。
 */
export async function uninstall(
  opts: UninstallOptions,
): Promise<UninstallResult> {
  const ctx = lifecycleContext(opts);
  const all = opts.all === true;
  const processEnv = opts.processEnv ?? Deno.env.toObject();
  const userHome = opts.userHome ?? processEnv["HOME"] ?? "";
  const binDir = opts.binDir ?? processEnv["NOJ_BIN_DIR"] ??
    "/usr/local/bin";
  const log = (kind: StatusKind, text: string): void => ctx.status(kind, text);

  const finish = (
    result: Omit<UninstallResult, keyof LifecycleBaseResult>,
    base: LifecycleBaseResult,
  ): UninstallResult => {
    const full: UninstallResult = { ...base, ...result };
    if (ctx.jsonMode) emitJson(uninstallPayload(full), ctx.io);
    return full;
  };
  // volumesRemoved 反映"第 4 步是否真的删了卷"：第 4 步自身失败或更早失败时为
  // false，之后的清理失败（软链/删目录）不改变它（T15 评审 Minor 4）。
  const fail = (
    error: string,
    removed: string[] = [],
    volumesRemoved = false,
  ): UninstallResult => {
    ctx.error(error);
    return finish(
      {
        all,
        volumesRemoved,
        removedCommands: removed,
        installDirRemoved: false,
      },
      failed(ctx.dir, error),
    );
  };

  // ---- 1. confirm_uninstall：先于一切副作用（零 runner 调用）----
  const refusal = await confirmUninstall(ctx, opts);
  if (refusal !== null) return fail(refusal);

  // ---- 2. check_uninstall_dependencies：docker/daemon/compose/env/compose ----
  log("info", "检查卸载环境");
  const prepared = await checkUninstallDependencies({
    dir: ctx.dir,
    runner: opts.runner,
    dockerBin: opts.dockerBin,
  });
  if (!prepared.ok) return fail(prepared.error);

  // compose down 参数：bash 置 INCLUDE_ALL_PROFILES=1，故 **judge 恒带**
  // （uninstall 前不判 judge_enabled，见选择 (a) 的注释）；再叠加同样必须覆盖的
  // monitoring，使 profiled 服务（prometheus/alertmanager）不在卸载后残留。
  // --profile 对未声明该 profile 的 compose 文件是**惰性**的，故无条件带上不改变
  // 默认卸载语义。monitoring 的存在性取自 T10 的 PROD_SERVICES 单一事实源
  // （compose_test.ts 已把它与真实 docker-compose.prod.yml 双向比对），不手抄清单。
  const monitoring = PROD_SERVICES.some((service) =>
    service.profile === "monitoring"
  );
  const uninstallOptions: ComposeOptions = {
    composeFile: prepared.composeFile,
    envFile: prepared.envFile,
    judge: true,
    monitoring,
  };

  // ---- 3. --all 的安装目录守卫：必须早于 down（bash production.sh:509）----
  if (all) {
    try {
      await assertRemovableInstallDir(ctx.dir, processEnv, {
        cliBinary: opts.cliBinary,
      });
    } catch (error) {
      return fail((error as Error).message);
    }
  }

  // ---- 4. compose down：默认 --rmi local；--all 加 --rmi all --volumes ----
  const command = all
    ? ["down", "--remove-orphans", "--rmi", "all", "--volumes"]
    : ["down", "--remove-orphans", "--rmi", "local"];
  // `down` 成功即代表卷删除这一步已完成（默认命令本就不带 --volumes，字段为 false）。
  // 该事实必须**在后续清理之前**固定下来：软链/删目录失败不能让 `volumesRemoved`
  // 退回 false（T15 评审 Minor 4）。
  const result = await runComposeSub(opts.runner, uninstallOptions, command);
  const text = composeOutputText(result);
  if (text !== "") emitHuman(text, ctx.io);
  if (!Array.isArray(result) && result.code !== 0) {
    const detail = result.stderr.trim();
    return fail(
      detail === ""
        ? `卸载生产服务失败（docker compose 退出码 ${result.code}）`
        : detail,
    );
  }
  const volumesRemoved = all;

  // ---- 5. unregister_command：只删指向本安装目录的软链 ----
  let removed: string[] = [];
  try {
    removed = await unregisterCommand({
      dir: ctx.dir,
      binDir,
      userHome,
    });
  } catch (error) {
    return fail((error as Error).message, removed, volumesRemoved);
  }
  if (removed.length === 0) {
    ctx.error("未找到指向当前安装目录的 PATH 命令软链接");
  } else {
    for (const path of removed) {
      log("success", `已移除 PATH 命令：${path}`);
    }
  }

  // ---- 6. remove_install_directory：仅 --all，且守卫已在 down 之前通过 ----
  let installDirRemoved = false;
  if (all) {
    try {
      await removeInstallDirectory(ctx.dir, processEnv, {
        cliBinary: opts.cliBinary,
      });
    } catch (error) {
      return fail((error as Error).message, removed, volumesRemoved);
    }
    installDirRemoved = true;
    log("success", `已删除 NOJ 安装目录：${ctx.dir}`);
  }

  // ---- 结果文案（deploy.sh:1104/1107-1108 逐字）----
  if (all) {
    log("success", "生产容器、网络、本地镜像和数据卷已清理");
  } else {
    log("success", "生产容器、网络和 Compose 管理的本地镜像已清理");
    log("success", "数据卷、生产配置、备份和部署目录已保留");
  }

  return finish(
    {
      all,
      volumesRemoved,
      removedCommands: removed,
      installDirRemoved,
    },
    {
      dir: ctx.dir,
      state: "stopped",
      noOp: false,
      exitCode: 0,
      error: null,
    },
  );
}

/** `uninstall` 的 `--json` 载荷（stdout 只含这一个 JSON 文档）。 */
function uninstallPayload(result: UninstallResult): Record<string, unknown> {
  return {
    dir: result.dir,
    all: result.all,
    volumesRemoved: result.volumesRemoved,
    removedCommands: result.removedCommands,
    installDirRemoved: result.installDirRemoved,
    state: result.state,
    noOp: result.noOp,
    error: result.error,
  };
}
