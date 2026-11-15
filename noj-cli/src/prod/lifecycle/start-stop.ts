// start / stop / restart：基于状态机的服务启停与重启编排。

import { downIsNoOp, transition, upIsNoOp } from "../../core/state.ts";
import { emitHuman, emitJson } from "../../output/render.ts";
import {
  composeOutputText,
  runComposeSub,
  WAIT_FAILURE_HINT,
  waitForStack,
} from "./steps.ts";
import { failed, jsonPayload, lifecycleContext } from "./context.ts";
import type { LifecycleContext } from "./context.ts";
import { prepareLifecycle, probeState } from "./services.ts";
import type { LifecycleBaseResult, LifecycleOptions } from "./services.ts";

export async function startWith(
  ctx: LifecycleContext,
  opts: LifecycleOptions,
): Promise<LifecycleBaseResult> {
  const prepared = await prepareLifecycle(ctx, opts);
  if (!prepared.ok) {
    return { ...failed(ctx.dir, prepared.error), state: "uninitialized" };
  }

  const probe = await probeState(ctx, opts, prepared.composeOptions);
  if (!probe.ok) return failed(ctx.dir, probe.error);

  // running 时 up 是 no-op（changed=false）→ 不重复启动。
  const decision = transition(probe.state, "up");
  if (upIsNoOp(probe.state)) {
    ctx.status("success", decision.message);
    return {
      dir: ctx.dir,
      state: decision.state,
      noOp: true,
      exitCode: 0,
      error: null,
    };
  }

  const wait = await waitForStack(
    opts.runner,
    prepared.composeOptions,
    (text) => emitHuman(text, ctx.io),
  );
  if (!wait.ok) {
    const error = wait.error ?? WAIT_FAILURE_HINT;
    ctx.error(error);
    return failed(ctx.dir, error);
  }

  ctx.status("success", "生产服务已启动");
  return {
    dir: ctx.dir,
    state: "running",
    noOp: false,
    exitCode: 0,
    error: null,
  };
}

/** `stop` 的核心（不写 JSON；由公开入口按模式补写）。 */
export async function stopWith(
  ctx: LifecycleContext,
  opts: LifecycleOptions,
): Promise<LifecycleBaseResult> {
  const prepared = await prepareLifecycle(ctx, opts);
  if (!prepared.ok) {
    return { ...failed(ctx.dir, prepared.error), state: "uninitialized" };
  }

  const probe = await probeState(ctx, opts, prepared.composeOptions);
  if (!probe.ok) return failed(ctx.dir, probe.error);

  // stopped 时 down 是 no-op（changed=false）→ 不重复关闭。
  const decision = transition(probe.state, "down");
  if (downIsNoOp(probe.state)) {
    ctx.status("success", decision.message);
    return {
      dir: ctx.dir,
      state: decision.state,
      noOp: true,
      exitCode: 0,
      error: null,
    };
  }

  ctx.status("info", "停止生产服务");
  // 裸 `stop` 子命令——绝不含 down/-v，数据卷保留。
  const stopped = await runComposeSub(opts.runner, prepared.composeOptions, [
    "stop",
  ]);
  const text = composeOutputText(stopped);
  if (text !== "") emitHuman(text, ctx.io);
  if (!Array.isArray(stopped) && stopped.code !== 0) {
    const error = "停止生产服务失败，请执行 status 和 logs 排查";
    ctx.error(error);
    return failed(ctx.dir, error);
  }

  ctx.status("success", "服务已停止，数据卷已保留");
  return {
    dir: ctx.dir,
    state: "stopped",
    noOp: false,
    exitCode: 0,
    error: null,
  };
}

/**
 * `start`：`prepare_and_check` → `wait_for_stack`。
 *
 * 先探测当前态，`upIsNoOp(当前态)` 为真即 **no-op**，绝不重复
 * 执行 `compose up`。no-op 文案取自 `transition(..., "up").message`。
 */
export async function start(
  opts: LifecycleOptions,
): Promise<LifecycleBaseResult> {
  const ctx = lifecycleContext(opts);
  const result = await startWith(ctx, opts);
  if (ctx.jsonMode) emitJson(jsonPayload(result), ctx.io);
  return result;
}

/**
 * `stop`：`prepare_and_check` → `run_compose stop`。
 *
 * **绝不使用 `down`/`-v`/`--volumes`**：服务停止，数据卷保留。
 * `downIsNoOp(当前态)` 为真即 **no-op**（已 stopped 不再 stop），
 * no-op 文案取自 `transition(..., "down").message`。
 */
export async function stop(
  opts: LifecycleOptions,
): Promise<LifecycleBaseResult> {
  const ctx = lifecycleContext(opts);
  const result = await stopWith(ctx, opts);
  if (ctx.jsonMode) emitJson(jsonPayload(result), ctx.io);
  return result;
}

/**
 * `restart`：**先 stop 再 start**。
 *
 * `transition(最终态, "restart")` 表达目标态 running（changed 恒
 * 为 true，restart 从不停用）；实际编排复用 `stop` → `start`，因此中间态、
 * no-op 判定与错误传播都与两命令各自独立时一致。
 *
 * 顺序断言（测试锁定）：`stop` 的 compose 调用严格早于 `up`。JSON 模式只在
 * 最后输出**一个**文档（内部两步不各自写 stdout），stdout 因此逐字节合法。
 */
export async function restart(
  opts: LifecycleOptions,
): Promise<LifecycleBaseResult> {
  const ctx = lifecycleContext(opts);
  const stopped = await stopWith(ctx, opts);
  if (stopped.exitCode !== 0) {
    if (ctx.jsonMode) emitJson(jsonPayload(stopped), ctx.io);
    return stopped;
  }
  const started = await startWith(ctx, opts);
  const target = transition(started.state, "restart");
  const result: LifecycleBaseResult = {
    ...started,
    state: started.exitCode === 0 ? target.state : "error",
  };
  if (ctx.jsonMode) emitJson(jsonPayload(result), ctx.io);
  return result;
}
