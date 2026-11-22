/**
 * 后台任务统一生命周期（P2a，2026-10-20 架构整治）。
 *
 * 背景：此前后台组件形态各异——消费者返回 `ConsumerHandle`（启动函数 +
 * `requestShutdown()`）、定时任务返回 `void`（句柄直接丢弃）、
 * 教学/存储核对返回 `{ stop, done }`。关闭流程只能逐个记忆调用方式，
 * 且多数组件**没有等待在途处理结束**的入口：进程在 in-flight 写库中途退出，
 * 或数据库连接先被关闭、后台任务继续写入。
 *
 * 本模块把「停止」与「完成」收敛为唯一契约：
 *
 * - `stop()`：停止接受新工作（清定时器 / 请求消费者退出），**不**等待；
 * - `done`：所有在途工作结束的 Promise；**允许 reject**，失败由
 *   {@link ManagedTaskGroup.doneAll} 汇总上报，而不是被静默吞掉。
 *
 * 关闭顺序固定为：`group.stopAll()` → `await group.doneAll()` →
 * 关闭 Redis / 数据库连接。业务模块只负责把自己的循环包成 `ManagedTask`，
 * 不再各自实现停止语义。
 */

/** 可被统一停止并等待完成的后台任务。 */
export interface ManagedTask {
  /** 任务名（日志与关闭顺序诊断用，稳定、不含动态数据）。 */
  name: string;
  /**
   * 停止接受新工作；幂等，不等待在途工作。
   *
   * 允许抛错：任务组会记录该错误、继续停止其余任务，并在 `doneAll()` 中
   * 与其他失败一起汇总，不会因为单个 `stop()` 失败而漏停其他任务。
   */
  stop(): void;
  /**
   * 所有在途工作结束的 Promise。
   *
   * **允许 reject**：任务失败时由 {@link ManagedTaskGroup.doneAll} 等待全部
   * 任务 settle 后汇总，并保留原始错误作为 `cause` 或 `AggregateError.errors`。
   */
  done: Promise<void>;
}

/** 后台任务集合：统一停止并等待全部完成。 */
export interface ManagedTaskGroup {
  /**
   * 登记一个任务。
   *
   * 必须在 {@link ManagedTaskGroup.stopAll} / {@link ManagedTaskGroup.shutdown}
   * 之前调用。关闭流程开始后再调用会先尽力停止并观察传入任务，然后抛出
   * `Error`，避免产生无人停止、无人等待的后台任务。
   */
  add(task: ManagedTask): ManagedTask;
  /**
   * 停止全部任务（按登记的**逆序**停止，先启动的后停）。
   *
   * 单个任务的 `stop()` 抛错不会阻断其余任务：错误会被记录用于诊断，并在
   * `doneAll()` 中汇总。重复调用幂等。
   */
  stopAll(): void;
  /**
   * 等待全部任务 settle 后汇总失败（含任务名、停止错误与原始 `cause`）。
   *
   * 任一任务失败都不会阻止其余任务被等待。只要存在失败就抛出：
   * 单个失败抛出带 `cause` 的 `Error`，多个失败抛出 `AggregateError`。
   */
  doneAll(): Promise<void>;
  /**
   * 停止并等待全部完成（关闭流程的唯一入口）。
   *
   * 使用闭包实现，不依赖 `this`，因此解构后调用仍然有效。重复调用返回
   * 同一个 Promise，具备幂等性。
   */
  shutdown(): Promise<void>;
  /** 当前登记的任务名（诊断/测试用）。 */
  names(): string[];
}

/**
 * 把一个 {stop, done} 形状的既有句柄适配为 {@link ManagedTask}。
 *
 * 适配层只做类型收窄，不改变完成语义：`handle.done` 的拒绝会原样传递给
 * 返回任务的 `done`，由任务组汇总。与此同时立即挂一个空处理器观察早期拒绝，
 * 避免 `doneAll()` 尚未调用时触发 unhandled rejection；空处理器不会改变
 * Promise 的拒绝状态，后续 `await task.done` / `doneAll()` 仍能看到原始错误。
 */
export function adoptManagedTask(
  name: string,
  handle: { stop(): void; done: Promise<unknown> },
): ManagedTask {
  const done: Promise<void> = Promise.resolve(handle.done).then(() =>
    undefined
  );
  done.catch(() => {});
  return {
    name,
    stop: () => handle.stop(),
    done,
  };
}

/**
 * 安全的内部日志：日志设施自身抛错时不得影响主流程（例如停止其余任务）。
 */
function reportInternalError(message: string, error: unknown): void {
  try {
    console.error(message, error);
  } catch {
    // 日志设施自身异常时不再向上传播。
  }
}

/** 周期任务选项。 */
export interface PeriodicTaskOptions {
  /** 任务名（稳定标识）。 */
  name: string;
  /** 轮询间隔（毫秒），必须是正有限数。 */
  intervalMs: number;
  /** 是否在启动时立即执行一轮（默认 false，与既有 sweeper/worker 行为一致）。 */
  runImmediately?: boolean;
  /** 单轮工作；抛错由 {@link PeriodicTaskOptions.onError} 处理，不中断后续轮次。 */
  run: () => Promise<void> | void;
  /**
   * 单轮失败处理（默认 `console.error`；生产传 logger）。
   *
   * 允许返回 Promise：轮次会等待其完成后才结束，`done` 不会提前 resolve。
   * 自身同步抛错或返回 rejected Promise 都只降级为内部日志，不会泄漏。
   */
  onError?: (error: unknown) => void | Promise<void>;
}

/**
 * 启动一个周期任务并返回可停止、可等待的句柄。
 *
 * 停止语义：{@link ManagedTask.stop} 清定时器并标记停止，**不**打断正在执行的
 * 那一轮；{@link ManagedTask.done} 在该轮（以及它触发的错误处理）结束后 resolve。
 * 这保证关闭时不会出现「定时器已清但写库仍在进行、随后数据库连接被关闭」的竞态。
 *
 * 单轮重叠保护：上一轮未结束时不会启动新一轮（周期任务可能因数据库慢而超时），
 * 与既有 sweeper/worker 的实际行为一致。`inFlight` 标志在调用 `run()` **之前**
 * 置位，即使 `run()` 同步抛错并触发同步的 `stop()`，`done` 也不会提前完成。
 *
 * `run()` 的同步抛错不会逃逸；`onError` 自身同步抛错或返回 rejected Promise 也
 * 只会降级为内部日志，不会产生未处理的 Promise 拒绝。
 *
 * @param options 周期任务选项
 * @returns 统一句柄
 */
export function startPeriodicTask(
  options: PeriodicTaskOptions,
): ManagedTask {
  const { name, intervalMs, run, runImmediately = false } = options;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(
      `[${name}] intervalMs 必须是正有限数，实际为 ${String(intervalMs)}`,
    );
  }

  const onError = options.onError ?? ((error: unknown) => {
    reportInternalError(`[${name}] 后台任务失败`, error);
  });

  let stopped = false;
  /** 单轮是否在途；在调用 run 之前置位，避免同步重入导致 done 提前完成。 */
  let inFlight = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const settleDoneIfIdle = (): void => {
    if (stopped && !inFlight) resolveDone();
  };

  /** 处理单轮错误；等待 async onError 完成，抛错或 rejected Promise 都不得泄漏。 */
  const handleRoundError = async (error: unknown): Promise<void> => {
    try {
      await onError(error);
    } catch (handlerError) {
      reportInternalError(`[${name}] 后台任务错误处理器抛错`, handlerError);
    }
  };

  const startRound = (): void => {
    if (stopped || inFlight) return;
    inFlight = true;
    const execute = async (): Promise<void> => {
      try {
        await run();
      } catch (error) {
        await handleRoundError(error);
      } finally {
        inFlight = false;
        settleDoneIfIdle();
      }
    };
    // execute 自身不会 reject（run/onError 均已捕获）；catch 仅作防回归兜底。
    void execute().catch((error: unknown) => {
      reportInternalError(`[${name}] 周期任务轮次清理失败`, error);
    });
  };

  const timer = setInterval(startRound, intervalMs);
  if (runImmediately) startRound();

  return {
    name,
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      settleDoneIfIdle();
    },
    done,
  };
}

/** 内部失败记录：保留阶段、任务名与原始原因（不丢失堆栈/cause 链）。 */
interface TaskFailure {
  name: string;
  phase: "stop" | "done";
  reason: unknown;
}

/** 把原始失败原因压缩成可读摘要；原始对象仍通过 cause/errors 保留。 */
function describeFailureReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

/** 构造保留原始错误的汇总错误：单个失败带 cause，多个失败用 AggregateError。 */
function buildFailureError(failures: TaskFailure[]): Error {
  const summary = failures
    .map((failure) =>
      `任务 ${failure.name} ${failure.phase}() 失败：${
        describeFailureReason(failure.reason)
      }`
    )
    .join("；");
  const message = `后台任务未干净结束：${summary}`;
  if (failures.length === 1) {
    return new Error(message, { cause: failures[0]!.reason });
  }
  return new AggregateError(
    failures.map((failure) => failure.reason),
    message,
  );
}

/**
 * 创建一个任务组。
 *
 * 关闭顺序：{@link ManagedTaskGroup.shutdown} 逆序 {@link ManagedTask.stop}，
 * 再 {@link ManagedTaskGroup.doneAll}。逆序停止使「先启动的依赖更少」的假设成立
 * （例如消费者先于其订阅的 Redis 连接停止）。
 *
 * 所有登记任务的 `done` 在登记时即挂上处理器，避免没有调用者时出现
 * unhandled rejection；失败仍由 `doneAll()` 汇总。
 *
 * @returns 任务组
 */
export function createManagedTaskGroup(): ManagedTaskGroup {
  const tasks: ManagedTask[] = [];
  const stopFailures: TaskFailure[] = [];
  let stopping = false;
  let shutdownPromise: Promise<void> | null = null;

  /** 观察 done 的拒绝而不改变其状态；doneAll 仍能拿到原始错误。 */
  const observeDone = (done: Promise<void>): void => {
    done.catch(() => {});
  };

  const stopAll = (): void => {
    if (stopping) return;
    stopping = true;
    for (let i = tasks.length - 1; i >= 0; i--) {
      const task = tasks[i]!;
      try {
        task.stop();
      } catch (error) {
        stopFailures.push({ name: task.name, phase: "stop", reason: error });
        // 立即诊断，同时保留原始错误对象供 doneAll 汇总。
        reportInternalError(`[managed-task] 停止任务失败：${task.name}`, error);
      }
    }
  };

  const doneAll = async (): Promise<void> => {
    const snapshot = tasks.slice();
    const results = await Promise.allSettled(
      snapshot.map((task) => task.done),
    );
    const failures: TaskFailure[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === "rejected") {
        failures.push({
          name: snapshot[i]!.name,
          phase: "done",
          reason: result.reason,
        });
      }
    }
    failures.push(...stopFailures);
    if (failures.length > 0) {
      throw buildFailureError(failures);
    }
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== null) return shutdownPromise;
    shutdownPromise = (async () => {
      stopAll();
      await doneAll();
    })();
    // 预先观察拒绝：调用方可能因超时竞速而放弃等待，避免无人 await 时
    // 产生未处理的 Promise 拒绝；该处理器不改变 shutdownPromise 的拒绝状态。
    shutdownPromise.catch(() => {});
    return shutdownPromise;
  };

  const add = (task: ManagedTask): ManagedTask => {
    if (stopping) {
      // 关闭流程已开始：调用方可能已经启动了任务。先尽力停止并观察 done，
      // 再明确拒绝登记，确保不会产生无人停止、无人等待的后台任务。
      try {
        task.stop();
      } catch (error) {
        reportInternalError(
          `[managed-task] 关闭后登记任务的停止失败：${task.name}`,
          error,
        );
      }
      observeDone(task.done);
      throw new Error(`任务组已停止，拒绝登记新任务：${task.name}`);
    }
    tasks.push(task);
    observeDone(task.done);
    return task;
  };

  return {
    add,
    stopAll,
    doneAll,
    shutdown,
    names: () => tasks.map((task) => task.name),
  };
}
