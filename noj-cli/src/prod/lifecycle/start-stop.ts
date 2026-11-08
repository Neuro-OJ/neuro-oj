// start / stop / restart：T4 状态机接线后的服务启停与重启编排。

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

  // T4：running 时 up 是 no-op（changed=false）→ 不重复启动。
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

  // T4：stopped 时 down 是 no-op（changed=false）→ 不重复关闭。
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
  // 裸 `stop` 子命令（T10 无命名封装）——绝不含 down/-v，数据卷保留。
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
 * `start`（deploy.sh:1027-1032）：`prepare_and_check` → `wait_for_stack`。
 *
 * **T4 接线点**：先探测当前态，`upIsNoOp(当前态)` 为真即 **no-op**，绝不重复
 * 执行 `compose up`（bash 会无条件重跑 up；本实现按 brief 的“已 running 时
 * no-op”要求收紧）。no-op 文案逐字取自 T4 `transition(..., "up").message`。
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
 * `stop`（deploy.sh:1045-1050）：`prepare_and_check` → `run_compose stop`。
 *
 * **绝不使用 `down`/`-v`/`--volumes`**：bash 明写“服务已停止，数据卷已保留”。
 * **T4 接线点**：`downIsNoOp(当前态)` 为真即 **no-op**（已 stopped 不再 stop），
 * no-op 文案逐字取自 T4 `transition(..., "down").message`。
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
 * `restart`：**先 stop 再 start**（production.sh:437-441 的逐字顺序）。
 *
 * **T4 接线点**：`transition(最终态, "restart")` 表达目标态 running（changed 恒
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

// ---------------- update / upgrade（T16，production.sh:201-440 + deploy.sh:1034-1044） ----------------
//
// `update` 是生产升级的唯一入口，`upgrade` 是别名。固定版本模式取自 `.env.prod`
// 的 `NOJ_VERSION`（先同步部署文件再升级）；`--latest` 查询资产就绪的稳定
// Release，归一化比较相等即 no-op（零 compose/备份/写配置），否则先写暂存配置、
// 升级成功后才原子提交。
//
// 升级序列（P1a 起验签先于启动，P1d 起自动排空）：`prepare_and_check` → 解析目标
// 配置 → `ensure_backup_passphrase` → **备份** → `compose pull` → **验签** →
// **drain enter/wait** → `wait_for_stack` → **drain exit** → `record_deployment_metadata`。
//
// 备份是升级序列里不可省的一步：`update` 经注入点 {@link UpdateOptions.backup}
// 调用，未注入即**明确的运行失败**（退出码 1，且尚未 pull/up），绝不静默跳过。

/** update/upgrade 的注入点：在 {@link LifecycleOptions} 上追加升级专用项。 */
