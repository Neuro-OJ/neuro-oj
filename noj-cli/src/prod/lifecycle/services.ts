// 生产服务日常操作（共用前置）：生命周期命令公共选项/结果、配置校验前置、状态探测、status 与 logs。

import { prodState } from "../../core/state.ts";
import type { DeployState } from "../../core/state.ts";
import { emitHuman, emitJson } from "../../output/render.ts";
import type { RenderIO } from "../../output/render.ts";
import type { StatusKind } from "../../output/theme.ts";
import type { CommandRunner } from "../../runtime/command.ts";
import type { ColorMode } from "../../util/color.ts";
import { composeLogs, composePs } from "../compose.ts";
import type { ComposeOptions } from "../compose.ts";
import {
  applyLogsColor,
  decideLogsColor,
  mergeColorSource,
  prepareAndCheck,
} from "./steps.ts";
import type { LogsColorDecision } from "./steps.ts";
import type { PreparedEnvironment } from "./steps.ts";
import {
  emitFailure,
  failed,
  jsonPayload,
  lifecycleContext,
} from "./context.ts";
import type { LifecycleContext } from "./context.ts";

export interface LifecycleOptions {
  /** 生产安装目录（`--dir`）；入口负责归一化（T9 `validateTargetDir`）。 */
  dir: string;
  /** 外部命令注入点（docker）。 */
  runner: CommandRunner;
  /** 人类可读输出汇聚点；缺省直达真实进程流。 */
  io?: RenderIO;
  /** 原始参数：仅用于 `isJsonMode` 判定 `--json`（缺省视为人类模式）。 */
  args?: string[];
  /** 着色模式（`--color`）；缺省 `auto`（非 TTY 自动关色）。 */
  color?: ColorMode;
  /**
   * judge socket 存在性探测（T11 `checkJudgeSocket` 的注入点）。
   *
   * 仅 judge 启用时被调用；缺省不探测 = bash judge 关闭时的「已跳过」分支。
   */
  socketExists?: (path: string) => Promise<boolean>;
  /**
   * 端口占用探测（`lsof -nP -iTCP:<port> -sTCP:LISTEN` 的注入点）。
   *
   * 缺省不探测（等同 bash `command -v lsof` 不命中）；注入后命中即写一条
   * 端口冲突告警，**不阻断**命令（与 bash 的 `warn` 一致）。
   */
  probePort?: (port: number) => Promise<boolean>;
}

/** 四个生命周期命令的公共结果形状。 */
export interface LifecycleBaseResult {
  /** 归一化安装目录（无尾斜杠）。 */
  dir: string;
  /** T4 状态机给出的当前/最终状态。 */
  state: DeployState;
  /** 是否 no-op（未执行任何变更命令）。 */
  noOp: boolean;
  /** 进程退出码：0 成功（含 no-op）/ 1 运行失败；用法错误 2 由 CLI 层产出。 */
  exitCode: number;
  /** 运行失败的面向用户文案；成功为 null。 */
  error: string | null;
}

/** {@link status} 的结果。 */
export interface StatusResult extends LifecycleBaseResult {
  /** `docker compose ps` 的原始 stdout（`status --json` 的机器可读通道）。 */
  psOutput: string;
}

export { failed, jsonPayload, lifecycleContext };
// 注：LifecycleContext 由上游 lifecycle/context.ts 定义，LifecycleBaseResult 供本目录与门面共用。

/** 由已校验的环境构造 T10 compose 选项（judge → `--profile judge`）。 */
function composeOptionsOf(env: PreparedEnvironment): ComposeOptions {
  return {
    composeFile: env.composeFile,
    projectDirectory: env.dir,
    envFile: env.envFile,
    judge: env.judge,
  };
}

/** {@link prepareLifecycle} 的成功分支：已校验的环境事实 + 现成 compose 选项。 */
export type PreparedLifecycle = PreparedEnvironment & {
  composeOptions: ComposeOptions;
};

/**
 * `prepare_and_check` 的公共前置：配置校验（T13 评审 Important：与 install 同源）。
 *
 * `prepareAndCheck` 负责 bash `check_configuration` 的**六步**（env 文件 / 权限 /
 * 必填值 / judge socket / 端口 / compose config），本函数只把它接进命令上下文：
 * 1. 目录经 `validateTargetDir` 归一化（`lifecycleContext` 已做）；
 * 2. 环境探测注入点从 {@link LifecycleOptions} 透传（未注入即 bash 的「已跳过」/「无 lsof」）；
 * 3. 端口冲突告警走人类通道（T6/T8，`--json` 自动改道 stderr）；
 * 4. 失败诊断写 stderr 并回传文案。
 *
 * **零变更命令**：步骤 1–5 不调用 docker；步骤 6 的 `compose config` 只读解析。
 * 任一失败都发生在任何 `up`/`stop`/`down` 之前。
 */
export async function prepareLifecycle(
  ctx: LifecycleContext,
  opts: LifecycleOptions,
): Promise<PreparedLifecycle | { ok: false; error: string }> {
  const prepared = await prepareAndCheck({
    dir: ctx.dir,
    runner: opts.runner,
    socketExists: opts.socketExists,
    probePort: opts.probePort,
    write: (text) => emitHuman(text + "\n", ctx.io),
  });
  if (!prepared.ok) {
    ctx.error(prepared.error);
    return { ok: false, error: prepared.error };
  }
  ctx.status("success", "生产配置检查通过");
  // env 透传给 logs（T14）：着色取值需要读 .env.prod 的 LOG_COLOR / NO_COLOR，
  // 复用已读取的同一份值，避免在命令层再解析一遍配置文件。
  return { ...prepared, composeOptions: composeOptionsOf(prepared) };
}

/** 取“当前真实状态”：跑 `docker compose ps` 并用 T4 `prodState` 推断。 */
export async function probeState(
  ctx: LifecycleContext,
  opts: LifecycleOptions,
  options: ComposeOptions,
): Promise<
  | { ok: true; state: DeployState; psOutput: string }
  | { ok: false; error: string }
> {
  const result = await composePs(opts.runner, options);
  if (Array.isArray(result)) {
    // dryRun：没有真实输出可解析；属调用方误用，按运行失败处理。
    const error = "compose ps 未真实执行（dryRun）";
    ctx.error(error);
    return { ok: false, error };
  }
  // compose 的告警写在 stderr（可能混有 WARN 行）：原样转 stderr，不静默丢弃。
  if (result.stderr !== "") emitFailure(ctx.io, result.stderr);
  if (result.code !== 0) {
    const error = "docker compose ps 失败：" + result.stderr.trim();
    ctx.error(error);
    return { ok: false, error };
  }
  return { ok: true, state: prodState(result.stdout), psOutput: result.stdout };
}

/** T4 状态 → T8 状态符号种类 + 中文标签（人类可读摘要行）。 */
function stateLabel(state: DeployState): { kind: StatusKind; text: string } {
  switch (state) {
    case "running":
      return { kind: "success", text: "生产服务运行中（running）" };
    case "partial":
      return { kind: "warning", text: "生产服务部分运行（partial）" };
    case "stopped":
      return { kind: "info", text: "生产服务未运行（stopped）" };
    case "uninitialized":
      return { kind: "info", text: "生产服务未初始化（uninitialized）" };
    case "error":
      return { kind: "error", text: "生产服务处于错误状态（error）" };
  }
}

// ---------------- logs（T14，deploy.sh:1117-1158） ----------------

/**
 * logs 的选项：在 {@link LifecycleOptions} 上追加服务名、--follow 与着色取值来源。
 *
 * 命名为 LogsCommandOptions（而非 LogsOptions）：后者已被 maintain/logs.ts 的
 * JSON 编排日志命令占用，包入口（mod.ts）再导出会撞名。
 *
 * LOG_COLOR / NO_COLOR 的**取值**统一经 {@link LogsCommandOptions.env}（缺省读进程环境）
 * 与 .env.prod；命令层只做合并，开/关判定交回 resolveColor（见
 * lifecycle/steps.ts 的 decideLogsColor），不新造第二套解析。
 */
export interface LogsCommandOptions extends LifecycleOptions {
  /** 位置参数（服务名）；透传给 compose。缺省 = 所有服务。 */
  services?: string[];
  /** 是否 --follow（实时跟随）。 */
  follow?: boolean;
  /**
   * 进程环境快照；缺省 Deno.env.toObject()（与 install 的 processEnv 同义）。
   *
   * 只为可测：断言里不必污染真实进程环境，也便于模拟「进程 env > .env.prod」。
   */
  env?: Record<string, string>;
}

/**
 * logs 的结果：在公共形状上追加服务名、着色决策与是否跟随。
 *
 * `state` 恒为 `"running"` 且**不作探测**（与 bash `logs()` 一致：不查
 * `compose ps`）；它只是为满足 {@link LifecycleBaseResult} 的公共形状，
 * **不代表真实栈状态**。
 */
export interface LogsResult extends LifecycleBaseResult {
  /** 透传的服务名（与输入一致）。 */
  services: string[];
  /**
   * 最终**着色决策**：`force` / `inherit` / `no-color`。
   *
   * 命名刻意不叫 `color`——它不是 {@link ColorMode}
   * （`auto`/`always`/`never`），而是 `applyLogsColor` 落回 compose 参数的
   * 三态结论，也是 `--json` 载荷的一部分，便于测试断言。
   */
  colorDecision: LogsColorDecision;
  /** 是否走实时跟随路径。 */
  followed: boolean;
}

/**
 * logs（deploy.sh:1117-1158）：前置校验 → 着色判定 → compose logs。
 *
 * 迁移要点：
 * 1. **着色优先级**逐字对照 bash（见 steps.ts 的 decideLogsColor）：NO_COLOR 非空
 *    或 LOG_COLOR=never → --no-color；LOG_COLOR=always → 强制（子命令**之前**的
 *    全局 --ansi always）；否则按 stdout 是否 TTY（resolveColor）。取值
 *    **进程环境优先、回退 .env.prod**；
 * 2. **实时跟随走 CommandRunner.stream**：T10 composeLogs 经 run() 是**缓冲**的，
 *    --follow 会一直不返回、看不到输出（T10/T13 已登记）。因此 follow 分支先用
 *    T10 的 composeLogs(dryRun: true) 取参数数组，再交给 stream 逐行写 stdout；
 * 3. **非 follow 用缓冲路径并自行写 stdout**（runner 不替调用方打印，T10
 *    carry-forward）：stdout 原样写人类通道、stderr（compose 告警）原样转 stderr；
 * 4. **--json 纯净**：stdout 只有结果 JSON，日志与诊断都改道 stderr（T6/T13 先例）；
 * 5. **退出码**：0 成功 / 1 运行失败（前置校验不过、compose 非 0）；用法错误 2 由
 *    CLI 解析层产出。
 */
export async function logs(opts: LogsCommandOptions): Promise<LogsResult> {
  const ctx = lifecycleContext(opts);
  const services = opts.services ?? [];
  const followed = opts.follow === true;

  const prepared = await prepareLifecycle(ctx, opts);
  if (!prepared.ok) {
    const result: LogsResult = {
      ...failed(ctx.dir, prepared.error),
      services,
      colorDecision: "no-color",
      followed,
    };
    if (ctx.jsonMode) emitJson(logsPayload(result), ctx.io);
    return result;
  }

  // ---- 着色判定：进程环境优先，回退 .env.prod；开/关交回 resolveColor ----
  const processEnv = opts.env ?? Deno.env.toObject();
  const decision = decideLogsColor({
    logColor: mergeColorSource(
      processEnv["LOG_COLOR"],
      prepared.env["LOG_COLOR"],
    ),
    noColor: mergeColorSource(processEnv["NO_COLOR"], prepared.env["NO_COLOR"]),
    // bash 用 [[ -t 1 ]] 探测 **stdout**；这里保持同一流。
    stream: "stdout",
  });

  const logOptions = { ...prepared.composeOptions, services, follow: followed };
  // dryRun 只取参数数组：参数形状由 T10 唯一保证，着色两处插入由 T14 helper 完成。
  const dryRun = await composeLogs(opts.runner, {
    ...logOptions,
    dryRun: true,
  });
  if (!Array.isArray(dryRun)) {
    const error = "compose logs 参数构造失败（dryRun 未返回参数数组）";
    ctx.error(error);
    const result: LogsResult = {
      ...failed(ctx.dir, error),
      services,
      colorDecision: decision,
      followed,
    };
    if (ctx.jsonMode) emitJson(logsPayload(result), ctx.io);
    return result;
  }
  const args = applyLogsColor(dryRun, decision);

  const code = followed
    ? await streamLogs(opts.runner, args, ctx)
    : await runLogs(opts.runner, args, ctx);
  if (code !== 0) {
    const error = "查看生产服务日志失败（docker compose 退出码 " + code + "）";
    ctx.error(error);
    const result: LogsResult = {
      ...failed(ctx.dir, error),
      services,
      colorDecision: decision,
      followed,
    };
    if (ctx.jsonMode) emitJson(logsPayload(result), ctx.io);
    return result;
  }

  const result: LogsResult = {
    dir: ctx.dir,
    state: "running",
    noOp: false,
    exitCode: 0,
    error: null,
    services,
    colorDecision: decision,
    followed,
  };
  // JSON 模式：stdout 只含这一个文档；日志本体与诊断已改道 stderr（emitHuman）。
  if (ctx.jsonMode) emitJson(logsPayload(result), ctx.io);
  return result;
}

/** logs 的 `--json` 载荷（stdout 只含这一个 JSON 文档）。 */
function logsPayload(result: LogsResult): Record<string, unknown> {
  return {
    dir: result.dir,
    services: result.services,
    colorDecision: result.colorDecision,
    followed: result.followed,
    error: result.error,
  };
}

/** 非 follow：缓冲执行并**自行**写出（runner 不打印）。 */
async function runLogs(
  runner: CommandRunner,
  args: string[],
  ctx: LifecycleContext,
): Promise<number> {
  const result = await runner.run("docker", args);
  // 日志本体是人类通道输出（--json 时自动改道 stderr），告警（compose stderr）
  // 同样改道——stdout 在 JSON 模式下必须逐字节为 JSON。
  emitHuman(result.stdout, ctx.io);
  // compose 告警属于诊断：**永远 stderr**（对照 bash 的 >&2 继承），
  // 这样重定向 stdout 时告警仍可见、--json 的 stdout 也不被污染。
  if (result.stderr !== "") emitFailure(ctx.io, result.stderr);
  return result.code;
}

/**
 * follow：实时逐行执行（T13 报告的缺口在本任务闭合）。
 *
 * runner 未实现 stream（P2 既有 fake）时**不静默降级**：直接报错，避免
 * --follow 悄悄退化成不可用的缓冲调用。
 */
async function streamLogs(
  runner: CommandRunner,
  args: string[],
  ctx: LifecycleContext,
): Promise<number> {
  if (runner.stream === undefined) {
    ctx.error("当前运行时不支持实时日志（CommandRunner.stream 缺失）");
    return 1;
  }
  // compose 的告警/进度走 stderr：显式与 stdout 分流（评审建议）。
  const emit = (line: string) => emitHuman(line + "\n", ctx.io);
  return await runner.stream("docker", args, emit, { onStderr: emit });
}

/**
 * `status`（deploy.sh:1112-1115）：`prepare_and_check` → `run_compose ps`。
 *
 * **T4 接线点**：`prodState(compose ps 的输出)` 推断 running / partial / stopped。
 * 状态**探测成功本身**即退出码 0（与 bash 一致：`compose ps` 成功就是成功，
 * 不因栈处于 stopped 而失败）；只有前置校验或 `compose ps` 失败才是 1。
 *
 * 人类输出 = 状态摘要行（T8） + 完整 compose 表（含原表头，与 bash 一致）；
 * `--json` 时 stdout 只有 `{ dir, state, ps }` 一个 JSON 文档，人类文字改道 stderr。
 */
export async function status(opts: LifecycleOptions): Promise<StatusResult> {
  const ctx = lifecycleContext(opts);
  const prepared = await prepareLifecycle(ctx, opts);
  if (!prepared.ok) {
    if (ctx.jsonMode) {
      emitJson({
        dir: ctx.dir,
        state: "uninitialized",
        ps: "",
        error: prepared.error,
      }, ctx.io);
    }
    return {
      ...failed(ctx.dir, prepared.error),
      state: "uninitialized",
      psOutput: "",
    };
  }

  const probe = await probeState(ctx, opts, prepared.composeOptions);
  if (!probe.ok) {
    if (ctx.jsonMode) {
      emitJson(
        { dir: ctx.dir, state: "error", ps: "", error: probe.error },
        ctx.io,
      );
    }
    return { ...failed(ctx.dir, probe.error), psOutput: "" };
  }

  if (ctx.jsonMode) {
    emitJson({ dir: ctx.dir, state: probe.state, ps: probe.psOutput }, ctx.io);
  }
  const label = stateLabel(probe.state);
  ctx.status(label.kind, label.text);
  if (probe.psOutput !== "") emitHuman(probe.psOutput, ctx.io);

  return {
    dir: ctx.dir,
    state: probe.state,
    noOp: false,
    exitCode: 0,
    error: null,
    psOutput: probe.psOutput,
  };
}

/** `start` 的核心（不写 JSON；由公开入口按模式补写）。 */
