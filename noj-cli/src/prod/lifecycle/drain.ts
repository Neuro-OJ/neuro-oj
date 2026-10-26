/**
 * 升级过程中的**自动排空**（P1d）：进入维护模式 → 等待 drained → 目标栈就绪后退出。
 *
 * ## 为什么需要它
 *
 * 升级会替换正在运行的 core/judge 镜像。若无排空，升级瞬间仍有在途评测
 * （evaluation_attempts）与队列任务跑在**旧版本**进程里，且新旧版本可能短暂
 * 并存；P1d 的 Core 内部维护 API 提供了协调点：
 *
 * ```text
 * 验签通过 ──→ maintain enter ──→ maintain wait ──→ compose up（目标栈）──→ maintain exit
 * ```
 *
 * ## 边界（本模块只做编排，不实现协议）
 *
 * 1. **HTTP 协议在容器内**：`enter/status/wait/exit` 由 `/app/bin/noj maintain`
 *    （`noj-core/scripts/maintain.ts`）执行，输出 `--json` 单文档；本模块用
 *    `docker compose run --rm --no-deps --entrypoint /app/bin/noj core maintain …`
 *    调用并解析文档。宿主机侧不复制一份 HTTP 客户端（两份实现必然漂移）。
 * 2. **可注入**：`UpdateOptions.drain` 是 seam；未注入或缺省时升级序列**完全不变**
 *    （既有测试与未启用排空的部署不受影响）。默认实现由 `cli.ts` 装配。
 * 3. **失败即中止**：enter/wait 失败（除旧 Core 的 `endpoint_unavailable` 过渡码）
 *    都返回可操作文案；upgradeWith 据此不启动目标栈、不提交暂存配置，并**尽力**
 *    执行 exit 以免残留维护态。
 * 4. **不持有模块级可变状态**（AGENTS.md §8.2 多副本约束）：只有类型、纯函数与
 *    注入的 runner。
 */

import { buildComposeArgs, CONTAINER_SERVICE } from "../../container.ts";
import { emitHuman } from "../../output/render.ts";
import type { RenderIO } from "../../output/render.ts";
import type { CmdResult, CommandRunner } from "../../runtime/command.ts";
import type { ComposeOptions } from "../compose.ts";

/** 默认排空等待超时（秒），与容器内 CLI 的 wait 缺省一致。 */
export const DEFAULT_DRAIN_TIMEOUT_SECS = 1800;

/**
 * 容器内 maintain 命令的**稳定**失败码（P1d 契约）。
 *
 * `endpoint_unavailable` 是过渡期专用：旧 Core 尚无 `/api/v1/internal/drain/*`
 * 时唯一允许"告警并继续升级"的失败；其余一律中止。
 */
export type DrainFailureCode =
  | "endpoint_unavailable"
  | "unauthorized"
  | "drain_unavailable"
  | "timeout"
  | "not_drained"
  | "network_error"
  | "http_error";

/** 一次排空步骤的结果（容器内 `maintain --json` 文档的宿主侧投影）。 */
export interface DrainResult {
  /** 步骤是否成功。 */
  ok: boolean;
  /** 失败码；成功为 null。 */
  code: DrainFailureCode | null;
  /** 面向用户/日志的错误文案；成功为 null。 */
  error: string | null;
  /** 最近一次 status 的 data（wait 超时时可据此列出 blockers）。 */
  data?: Record<string, unknown>;
}

/** 排空步骤的上下文：目标发布集的 compose 选项 + 超时。 */
export interface DrainContext {
  /** 目标 compose 选项（升级时 `--env-file` 指向**暂存**配置）。 */
  compose: ComposeOptions;
  /** `wait` 的超时秒数（`--drain-timeout`，默认 1800）。 */
  timeoutSecs: number;
}

/** 升级过程中的排空生命周期（`UpdateOptions.drain` 的注入点）。 */
export interface DrainLifecycle {
  /** 进入维护模式（幂等）。 */
  enter(context: DrainContext): Promise<DrainResult>;
  /** 轮询直到 drained 或超时。 */
  wait(context: DrainContext): Promise<DrainResult>;
  /** 退出维护模式（幂等）。 */
  exit(context: DrainContext): Promise<DrainResult>;
}

/** 升级目标的排空所需事实（{@link ../lifecycle/target.ts} 的结构子集）。 */
export interface DrainTarget {
  /** 目标 compose 选项（`--env-file` 已指向生效配置）。 */
  composeOptions: ComposeOptions;
  /** 生效环境文件路径。 */
  envFile: string;
}

/** update 的排空开关（由 `UpdateOptions` 继承）。 */
export interface DrainOptions {
  /** 排空实现；未注入即不排空（保持既有升级序列，测试/过渡部署可用）。 */
  drain?: DrainLifecycle;
  /** `--skip-drain`：显式关闭自动排空。 */
  skipDrain?: boolean;
  /** `--drain-timeout`：等待排空的秒数（默认 1800）。 */
  drainTimeoutSecs?: number;
}

/** 排空步骤的输出通道（`LifecycleContext` 的结构子集）。 */
export interface DrainSinks {
  /** 人类输出（JSON 模式由 {@link emitHuman} 自动改道 stderr）。 */
  io: RenderIO;
}

/** 默认排空实现的依赖（一切外部访问可注入）。 */
export interface DefaultDrainDeps {
  /** docker 命令注入点（`compose run` 经它执行）。 */
  runner: CommandRunner;
  /** docker 可执行名（`NOJ_DEPLOY_DOCKER_BIN` 的等价）；缺省 `docker`。 */
  dockerBin?: string;
}

/** 允许的失败码集合（解析时把未知码归一到 `http_error`）。 */
const FAILURE_CODES: ReadonlySet<string> = new Set([
  "endpoint_unavailable",
  "unauthorized",
  "drain_unavailable",
  "timeout",
  "not_drained",
  "network_error",
  "http_error",
]);

/** 容器内 `maintain --json` 文档的形状（同文档只含一个 JSON）。 */
interface MaintainDocument {
  ok?: boolean;
  code?: string;
  error?: string;
  data?: Record<string, unknown>;
}

/** 契约里的失败提示（{@link failureText} 的兜底文案）。 */
const CODE_HINTS: Record<DrainFailureCode, string> = {
  endpoint_unavailable: "目标 Core 尚未提供内部维护/排空 API（旧版本）",
  unauthorized: "内部维护 API 鉴权失败（NOJ_INTERNAL_SERVICE_TOKEN 不一致）",
  drain_unavailable: "自动排空不可用（未配置 NOJ_INTERNAL_SERVICE_TOKEN）",
  timeout: "等待排空超时",
  not_drained: "排空未完成（仍有阻塞项）",
  network_error: "无法调用内部维护 API（容器/网络不可达）",
  http_error: "内部维护 API 返回错误",
};

/** 由 update 选项与目标配置构造排空上下文。 */
function contextOf(opts: DrainOptions, target: DrainTarget): DrainContext {
  return {
    compose: target.composeOptions,
    timeoutSecs: opts.drainTimeoutSecs ?? DEFAULT_DRAIN_TIMEOUT_SECS,
  };
}

/**
 * 从 stdout 中提取第一个**平衡的** JSON 对象。
 *
 * 容器内 CLI 的 `--json` 保证 stdout 只有一个 JSON 文档，但 `docker compose run`
 * 在少数版本/配置下可能把非 JSON 提示写到 stdout 前面；因此不直接 `JSON.parse`，
 * 而是从首个 `{` 起做括号配平（字符串内的括号不计数）。找不到返回 null。
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 把一次 runner 结果解析为 {@link DrainResult}。 */
function parseResult(result: CmdResult): DrainResult {
  const json = extractJsonObject(result.stdout);
  if (json !== null) {
    let doc: MaintainDocument | null = null;
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed === "object" && parsed !== null) {
        doc = parsed as MaintainDocument;
      }
    } catch {
      doc = null;
    }
    if (doc !== null) {
      if (doc.ok === true) {
        return doc.data === undefined
          ? { ok: true, code: null, error: null }
          : { ok: true, code: null, error: null, data: doc.data };
      }
      const code = doc.code !== undefined && FAILURE_CODES.has(doc.code)
        ? doc.code as DrainFailureCode
        : "http_error";
      const out: DrainResult = {
        ok: false,
        code,
        error: doc.error ?? CODE_HINTS[code],
      };
      if (doc.data !== undefined) out.data = doc.data;
      return out;
    }
  }
  // 非 JSON：docker compose 自身失败（镜像缺失/容器起不来/宿主机无 docker）
  const detail = result.stderr.trim() || result.stdout.trim() ||
    `docker compose 退出码 ${result.code}`;
  return {
    ok: false,
    code: "network_error",
    error: `维护命令未返回 JSON：${detail.split("\n").slice(0, 3).join(" ")}`,
  };
}

/** 结果 → 单行人类文案（供错误消息拼接）。 */
function failureText(result: DrainResult): string {
  const detail = result.error ?? CODE_HINTS[result.code ?? "http_error"];
  return result.code === null ? detail : `${detail}（${result.code}）`;
}

/** 失败码 → 可操作建议（终点用户提示，避免"失败了但不知道下一步"）。 */
function actionHint(code: DrainFailureCode | null): string | null {
  switch (code) {
    case "drain_unavailable":
      return "在 .env.prod 设置 NOJ_INTERNAL_SERVICE_TOKEN（openssl rand -hex 32）后重试；" +
        "或显式使用 --skip-drain";
    case "unauthorized":
      return "核对 .env.prod 的 NOJ_INTERNAL_SERVICE_TOKEN 与运行中的 Core 一致；" +
        "或显式使用 --skip-drain";
    case "timeout":
    case "not_drained":
      return "用 noj-cli maintain status 查看 blockers；等待任务清空后重试；" +
        "或显式使用 --skip-drain";
    default:
      return null;
  }
}

/** 组合失败文案（含建议与"尽力 exit"的结果）。 */
function drainFailure(
  prefix: string,
  result: DrainResult,
  exitError: string | null,
): string {
  let message = `${prefix}：${failureText(result)}`;
  const hint = actionHint(result.code);
  if (hint !== null) message += `\n  建议：${hint}`;
  if (exitError !== null) {
    message += `\n  另外：尽力退出维护模式失败（${exitError}）；` +
      "请人工执行 noj-cli maintain exit 恢复写请求";
  } else {
    message +=
      "\n  已尝试退出维护模式；若仍处于维护态，请人工执行 noj-cli maintain exit";
  }
  return message;
}

/** 执行一次排空调用并归一异常（注入实现抛错也不能击穿升级序列）。 */
async function settle(promise: Promise<DrainResult>): Promise<DrainResult> {
  try {
    return await promise;
  } catch (err) {
    return {
      ok: false,
      code: "network_error",
      error: (err as Error).message,
    };
  }
}

/** 尽力退出维护模式；返回失败文案（成功或旧 Core 过渡码返回 null）。 */
async function exitBestEffort(
  drain: DrainLifecycle,
  context: DrainContext,
): Promise<string | null> {
  const exited = await settle(drain.exit(context));
  if (exited.ok || exited.code === "endpoint_unavailable") return null;
  return failureText(exited);
}

/**
 * 升级前置步骤：`enter` → `wait`（在 pull+验签之后、启动目标栈之前调用）。
 *
 * @returns 失败文案（null = 可以继续升级）。以下情况返回 null：
 * - 未注入 drain 或显式 `--skip-drain`（保持既有行为）；
 * - enter 返回 `endpoint_unavailable`（旧 Core 无端点；过渡期一次性切换，
 *   打印告警后继续，不猜测"半排空"状态）。
 *
 * 失败时**尽力**执行 exit，避免把部署留在维护态。
 */
export async function drainBeforeUpgrade(
  opts: DrainOptions,
  target: DrainTarget,
  sinks: DrainSinks,
): Promise<string | null> {
  if (opts.drain === undefined || opts.skipDrain === true) return null;
  const context = contextOf(opts, target);

  emitHuman("\n== 进入维护模式并等待排空 ==\n", sinks.io);
  const entered = await settle(opts.drain.enter(context));
  if (!entered.ok) {
    if (entered.code === "endpoint_unavailable") {
      emitHuman(
        "! 目标 Core 尚无内部维护/排空 API（旧版本）；本次升级跳过自动排空。" +
          "过渡期一次性切换，升级后请确认维护模式未开启\n",
        sinks.io,
      );
      return null;
    }
    const exitError = await exitBestEffort(opts.drain, context);
    return drainFailure("进入维护模式失败", entered, exitError);
  }

  const waited = await settle(opts.drain.wait(context));
  if (!waited.ok) {
    const exitError = await exitBestEffort(opts.drain, context);
    return drainFailure("等待排空失败", waited, exitError);
  }
  emitHuman("✓ 排空完成，开始启动目标栈\n", sinks.io);
  return null;
}

/**
 * 升级后置步骤：`exit`（在 `waitForStack` 成功后调用）。
 *
 * @returns 失败文案（null = 已退出或未启用排空）。退出失败意味着**服务已启动但
 * 仍在维护模式**：必须显式报告半完成并给出人工恢复命令，绝不静默。
 */
export async function drainAfterUpgrade(
  opts: DrainOptions,
  target: DrainTarget,
  sinks: DrainSinks,
): Promise<string | null> {
  if (opts.drain === undefined || opts.skipDrain === true) return null;
  const context = contextOf(opts, target);
  const exited = await settle(opts.drain.exit(context));
  if (exited.ok) {
    emitHuman("✓ 已退出维护模式，恢复写请求\n", sinks.io);
    return null;
  }
  if (exited.code === "endpoint_unavailable") {
    emitHuman(
      "! 目标 Core 尚无内部维护/排空 API（旧版本）；跳过退出维护模式\n",
      sinks.io,
    );
    return null;
  }
  // 措辞必须同时适用于"目标栈已启动"与"waitForStack 失败"两条调用路径：
  // 只陈述"退出维护失败 → 可能仍处于维护模式"，不假设服务一定已就绪。
  return `退出维护失败（${
    failureText(exited)
  }）：部署仍可能处于维护模式。\n  ` +
    "请人工执行 noj-cli maintain exit 恢复写请求。";
}

/** 默认排空实现：构造 `docker compose run … core maintain <子命令> --json` 并解析。 */
export function createDrainLifecycle(
  deps: DefaultDrainDeps,
): DrainLifecycle {
  const dockerBin = deps.dockerBin ?? "docker";
  const execute = async (
    context: DrainContext,
    action: "enter" | "status" | "wait" | "exit",
    extra: string[] = [],
  ): Promise<DrainResult> => {
    const args = buildComposeArgs({
      composeFile: context.compose.composeFile,
      envFile: context.compose.envFile,
      service: CONTAINER_SERVICE,
      command: ["maintain", action, ...extra, "--json"],
      noDeps: true,
    });
    let result: CmdResult;
    try {
      result = await deps.runner.run(dockerBin, args);
    } catch (err) {
      return {
        ok: false,
        code: "network_error",
        error: `无法执行维护命令：${(err as Error).message}`,
      };
    }
    return parseResult(result);
  };
  return {
    enter: (context) => execute(context, "enter"),
    wait: (context) =>
      execute(context, "wait", [
        "--timeout",
        String(context.timeoutSecs),
        "--interval",
        "5",
      ]),
    exit: (context) => execute(context, "exit"),
  };
}
