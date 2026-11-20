/**
 * 进程关闭协调器（P2a，2026-10-20 架构整治）。
 *
 * 目标：把「停止接收新工作 → 等待在途工作 → 关闭依赖」收敛为一段可测试的
 * 纯逻辑，避免 main.ts 用 `Promise.race` 把超时当成成功、在后台任务仍写库时
 * 关闭 Redis/数据库，最后还以 0 退出。
 *
 * 关键语义：
 *
 * - HTTP 关闭与后台 `stopAll()` 在**任何 await 之前**发出，先切断新请求与新
 *   任务领取；随后才等待两者 settle。HTTP SSE 长连接可能让 `server.shutdown()`
 *   一直不返回，必须有独立超时；
 * - 只有 HTTP 排空**且**后台任务全部结束，才允许关闭 Redis/数据库；
 * - 任一阶段失败、停止抛错或超时都写入 {@link ShutdownReport.problems}，
 *   `clean` 为 false、`exitCode` 非 0；
 * - 任一阶段超时（包括 HTTP 未排空）时跳过依赖关闭并标记 `forceExit`，
 *   由调用方以非零码强制退出，进程退出回收连接——绝不在有在途写库时先关连接；
 * - 单任务失败（`doneAll` reject）表示任务已全部 settle，只是结果不干净：
 *   此时仍会关闭依赖，但报告不干净、退出码非 0；
 * - 每个依赖都会尝试关闭，某一个失败不会阻止其余依赖继续关闭，所有失败聚合上报。
 */

/** 关闭阶段。 */
export type ShutdownPhase = "http" | "tasks" | "connections" | "resources";

/** 单个关闭问题（失败或超时）。 */
export interface ShutdownProblem {
  phase: ShutdownPhase;
  /** 主体名：HTTP 服务名、任务名或依赖名。 */
  subject: string;
  kind: "error" | "timeout";
  message: string;
}

/** 关闭结果（纯数据，便于测试与统一日志）。 */
export interface ShutdownReport {
  /** 仅当 HTTP 排空、后台任务全部结束、依赖全部关闭且无任何问题时为 true。 */
  clean: boolean;
  /** 建议进程退出码：clean 为 0，否则非 0。 */
  exitCode: number;
  /** HTTP 是否在时限内完成排空。 */
  httpDrained: boolean;
  /** 后台任务是否在时限内全部结束（失败也算结束，但不干净）。 */
  tasksSettled: boolean;
  /** 已建立的长连接（SSE 等）是否在时限内全部关闭并完成收尾。 */
  connectionsSettled: boolean;
  /** 本次关闭触发的长连接数量。 */
  connectionsClosed: number;
  /** Redis/数据库等依赖是否已全部关闭。 */
  resourcesClosed: boolean;
  /** 是否为超时导致的强制退出（依赖被有意跳过关闭）。 */
  forceExit: boolean;
  problems: ShutdownProblem[];
  /** 人类可读摘要，不含动态敏感数据。 */
  summary: string;
}

/** HTTP 服务关闭入口（通常是 `Deno.HttpServer.shutdown`）。 */
export interface ShutdownHttp {
  name: string;
  shutdown(): Promise<void> | void;
}

/** 后台任务组的最小契约（与 ManagedTaskGroup 兼容）。 */
export interface ShutdownTaskGroup {
  stopAll(): void;
  doneAll(): Promise<void>;
}

/** 已建立长连接的关闭入口（主进程拥有，关闭后不得再接受新连接）。 */
export interface ShutdownConnectionRegistry {
  name: string;
  /** 同步关闭全部现有连接；返回触发关闭的数量。 */
  closeAll(): number;
  /** 等待这些连接的业务收尾（如 SSE setup 仍在途）全部结束。 */
  doneAll(): Promise<void>;
}

/** 需要最后关闭的共享依赖（Redis、数据库等）。 */
export interface ShutdownResource {
  name: string;
  close(): Promise<void> | void;
}

/** 关闭协调参数。 */
export interface ShutdownOptions {
  http: ShutdownHttp;
  tasks: ShutdownTaskGroup;
  resources: ShutdownResource[];
  /** HTTP 排空超时；0 或 Infinity 表示不设超时，其余须为有限正数。 */
  httpTimeoutMs: number;
  /** 后台任务结束超时；0 或 Infinity 表示不设超时，其余须为有限正数。 */
  tasksTimeoutMs: number;
  /** 长连接收尾超时；省略时沿用 tasksTimeoutMs。 */
  connectionsTimeoutMs?: number;
  /** 单个依赖关闭超时；0 或 Infinity 表示不设超时，其余须为有限正数。 */
  resourceTimeoutMs?: number;
  /** 已有 SSE 等长连接；在 stopAll 之后、等待 HTTP 排空之前同步关闭。 */
  connections?: ShutdownConnectionRegistry;
}

interface SettleResult {
  status: "fulfilled" | "rejected" | "timeout";
  error?: unknown;
}

/** 把可能同步抛错的函数统一转成 Promise。 */
function invoke(operation: () => Promise<void> | void): Promise<void> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

/** 在有界时间内等待 Promise settle；超时只返回状态，不会取消底层 Promise。 */
async function settleWithTimeout(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<SettleResult> {
  if (timeoutMs === 0 || timeoutMs === Infinity) {
    try {
      await promise;
      return { status: "fulfilled" };
    } catch (error) {
      return { status: "rejected", error };
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SettleResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
    // 关闭截止计时器必须保持 ref：若此时只剩这一个 deadline，unref 会让事件
    // 循环提前退出，纯逻辑测试会看到 Promise 永远不 settle。clear 在 finally。
  });
  const settled: Promise<SettleResult> = promise.then(
    (): SettleResult => ({ status: "fulfilled" }),
    (error): SettleResult => ({ status: "rejected", error }),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

/** 校验超时参数，避免 NaN/负数被 setTimeout 静默当作 0ms 立即超时。 */
function assertTimeout(name: string, value: number): void {
  const valid = value === Infinity ||
    (Number.isFinite(value) && value >= 0);
  if (!valid) {
    throw new TypeError(`${name} 必须是有限非负数或 Infinity，收到 ${value}`);
  }
}

/**
 * 执行一次完整的关闭流程。
 *
 * 调用顺序（重要）：
 * 1. **同步**调用 `http.shutdown()`（关闭监听、开始排空）；
 * 2. **同步**调用 `tasks.stopAll()`（停止任务领取）；
 * 3. **同步**调用 `connections.closeAll()`（关闭已有 SSE 长连接）；
 *    以上三步之间没有任何 await；
 * 4. 并行等待 HTTP 排空、任务结束与长连接收尾（各自有独立超时）；
 * 5. 仅当 HTTP 已排空、任务已结束且长连接收尾完成，才关闭依赖。
 *
 * 合法参数下该函数不抛错：所有运行期失败都反映在返回报告中，便于 main 统一
 * 记录并以非零码退出。仅当 timeout 参数为 NaN/负数等非法值时才抛 TypeError。
 *
 * @param options 关闭参数
 * @returns 关闭报告
 */
export async function performShutdown(
  options: ShutdownOptions,
): Promise<ShutdownReport> {
  assertTimeout("httpTimeoutMs", options.httpTimeoutMs);
  assertTimeout("tasksTimeoutMs", options.tasksTimeoutMs);
  assertTimeout(
    "connectionsTimeoutMs",
    options.connectionsTimeoutMs ?? options.tasksTimeoutMs,
  );
  assertTimeout(
    "resourceTimeoutMs",
    options.resourceTimeoutMs ?? 0,
  );
  const problems: ShutdownProblem[] = [];

  // 先发出 HTTP 关闭：关闭监听并开始排空（SSE 长连接可能拖住，后续有超时）。
  const httpResultPromise = settleWithTimeout(
    invoke(() => options.http.shutdown()),
    options.httpTimeoutMs,
  );

  // 在任何 await 之前停止后台任务领取，避免 HTTP 排空期间 worker 继续领取新任务。
  let stopError: unknown;
  let stopThrew = false;
  try {
    options.tasks.stopAll();
  } catch (error) {
    stopThrew = true;
    stopError = error;
  }

  // 在等待之前关闭已有 SSE 长连接，否则 server.shutdown() 永远等不到空闲。
  let connectionsClosed = 0;
  const connectionsDonePromise = options.connections
    ? settleWithTimeout(
      invoke(() => {
        connectionsClosed = options.connections!.closeAll();
        return options.connections!.doneAll();
      }),
      options.connectionsTimeoutMs ?? options.tasksTimeoutMs,
    )
    : Promise.resolve<SettleResult>({ status: "fulfilled" });

  const tasksResultPromise = settleWithTimeout(
    invoke(() => options.tasks.doneAll()),
    options.tasksTimeoutMs,
  );

  const [httpResult, tasksResult, connectionsResult] = await Promise.all([
    httpResultPromise,
    tasksResultPromise,
    connectionsDonePromise,
  ]);

  const httpDrained = httpResult.status === "fulfilled";
  if (httpResult.status === "rejected") {
    problems.push({
      phase: "http",
      subject: options.http.name,
      kind: "error",
      message: describeError(httpResult.error),
    });
  } else if (httpResult.status === "timeout") {
    problems.push({
      phase: "http",
      subject: options.http.name,
      kind: "timeout",
      message: `HTTP 未在 ${options.httpTimeoutMs}ms 内完成排空`,
    });
  }

  // doneAll 的 reject 约定为「所有任务都已 settle，但存在失败」；超时才是仍未结束。
  const tasksSettled = tasksResult.status !== "timeout";
  if (stopThrew) {
    problems.push({
      phase: "tasks",
      subject: "stopAll",
      kind: "error",
      message: `stopAll 抛错：${describeError(stopError)}`,
    });
  }
  if (tasksResult.status === "rejected") {
    problems.push({
      phase: "tasks",
      subject: "doneAll",
      kind: "error",
      message: describeError(tasksResult.error),
    });
  } else if (tasksResult.status === "timeout") {
    problems.push({
      phase: "tasks",
      subject: "doneAll",
      kind: "timeout",
      message: `后台任务未在 ${options.tasksTimeoutMs}ms 内结束`,
    });
  }

  const connectionsSettled = connectionsResult.status !== "timeout";
  if (options.connections) {
    if (connectionsResult.status === "rejected") {
      problems.push({
        phase: "connections",
        subject: options.connections.name,
        kind: "error",
        message: describeError(connectionsResult.error),
      });
    } else if (connectionsResult.status === "timeout") {
      problems.push({
        phase: "connections",
        subject: options.connections.name,
        kind: "timeout",
        message: `长连接未在 ${
          options.connectionsTimeoutMs ?? options.tasksTimeoutMs
        }ms 内完成收尾`,
      });
    }
  }

  // 超时（HTTP 未排空、任务/长连接仍在运行）意味着可能仍有在途写库：
  // 跳过依赖关闭，交给进程退出回收连接。
  const forced = !httpDrained || !tasksSettled || !connectionsSettled;
  let resourcesClosed = false;

  if (!forced) {
    resourcesClosed = true;
    const resourceTimeoutMs = options.resourceTimeoutMs ?? 0;
    const resourceResults = await Promise.all(
      options.resources.map((resource) =>
        settleWithTimeout(
          invoke(() => resource.close()),
          resourceTimeoutMs,
        ).then((result) => ({ resource, result }))
      ),
    );
    for (const { resource, result } of resourceResults) {
      if (result.status === "fulfilled") continue;
      resourcesClosed = false;
      problems.push({
        phase: "resources",
        subject: resource.name,
        kind: result.status === "timeout" ? "timeout" : "error",
        message: result.status === "timeout"
          ? `依赖未在 ${resourceTimeoutMs}ms 内关闭`
          : describeError(result.error),
      });
    }
  }

  const clean = httpDrained && tasksSettled && connectionsSettled &&
    resourcesClosed &&
    problems.length === 0 && !forced;
  const summaryParts = [
    httpDrained ? "HTTP 已完成排空" : "HTTP 未排空",
    tasksSettled ? "后台任务已结束" : "后台任务仍在运行",
    connectionsSettled ? "长连接已收尾" : "长连接仍在收尾",
    resourcesClosed ? "依赖已关闭" : "依赖未关闭",
  ];
  if (problems.length > 0) {
    summaryParts.push(`问题 ${problems.length} 项`);
  }
  if (forced) {
    summaryParts.push("非干净关闭，强制退出");
  }

  return {
    clean,
    exitCode: clean ? 0 : 1,
    httpDrained,
    tasksSettled,
    connectionsSettled,
    connectionsClosed,
    resourcesClosed,
    forceExit: forced,
    problems,
    summary: summaryParts.join("；"),
  };
}
