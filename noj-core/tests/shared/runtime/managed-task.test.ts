/**
 * 后台任务统一生命周期（ManagedTask）单元测试。
 *
 * 纯逻辑、零外部依赖：不连数据库/Redis，也不依赖真实时间。周期任务通过
 * 替身调度器（FakeScheduler）手动推进时间；在途工作全部用受控 Promise
 * （deferred）驱动，避免用短 sleep 碰运气。
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1";
import type { ManagedTask } from "../../../src/shared/runtime/managed-task.ts";
import {
  adoptManagedTask,
  createManagedTaskGroup,
  startPeriodicTask,
} from "../../../src/shared/runtime/managed-task.ts";

/** 保留真实 setTimeout，用于需要让出一个真实事件循环轮的场景。 */
const realSetTimeout = globalThis.setTimeout;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/** 受控 Promise：由测试决定何时 resolve/reject。 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 清空微任务队列，让 async 轮次推进到下一个 await。 */
async function settleMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/** 让出一个真实事件循环轮，主要用于观察 unhandledrejection。 */
function flushEventLoopTurn(): Promise<void> {
  return new Promise<void>((resolve) => realSetTimeout(resolve, 0));
}

/** 断言同步调用不抛错；当前 @std/assert 版本未提供 assertDoesNotThrow。 */
function assertDoesNotThrow(fn: () => void, message?: string): void {
  try {
    fn();
  } catch (error) {
    throw new Error(
      message ?? `预期不抛错，实际抛出：${String(error)}`,
      { cause: error },
    );
  }
}

type TimerCallback = () => void;

interface FakeTimer {
  due: number;
  intervalMs: number | null;
  callback: TimerCallback;
}

/**
 * 确定性调度器：替换全局 setInterval/setTimeout，由 advance() 手动推进。
 *
 * 只用于测试；生产接口不引入任何调度器注入参数。
 */
class FakeScheduler {
  #now = 0;
  #nextId = 1;
  #timers = new Map<number, FakeTimer>();
  #originals: {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  } | null = null;

  install(): void {
    if (this.#originals !== null) throw new Error("FakeScheduler 已安装");
    this.#originals = {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    };
    globalThis.setInterval = ((
      callback: TimerCallback,
      ms?: number,
    ): number => {
      const interval = Number(ms ?? 0);
      return this.#schedule(callback, interval, interval);
    }) as unknown as typeof setInterval;
    globalThis.setTimeout = ((
      callback: TimerCallback,
      ms?: number,
    ): number =>
      this.#schedule(
        callback,
        Number(ms ?? 0),
        null,
      )) as unknown as typeof setTimeout;
    const clear = ((id?: number): void => {
      if (typeof id === "number") this.#timers.delete(id);
    }) as unknown as typeof clearInterval;
    globalThis.clearInterval = clear;
    globalThis.clearTimeout = clear as unknown as typeof clearTimeout;
  }

  restore(): void {
    if (this.#originals === null) return;
    globalThis.setInterval = this.#originals.setInterval;
    globalThis.clearInterval = this.#originals.clearInterval;
    globalThis.setTimeout = this.#originals.setTimeout;
    globalThis.clearTimeout = this.#originals.clearTimeout;
    this.#originals = null;
    this.#timers.clear();
  }

  activeTimerCount(): number {
    return this.#timers.size;
  }

  /** 推进虚拟时间并依次执行到期回调；每个回调后清空微任务。 */
  async advance(ms: number): Promise<void> {
    const target = this.#now + Math.max(0, ms);
    for (;;) {
      let nextId: number | null = null;
      let next: FakeTimer | null = null;
      for (const [id, timer] of this.#timers) {
        if (timer.due > target) continue;
        if (
          next === null || timer.due < next.due ||
          (timer.due === next.due && id < nextId!)
        ) {
          next = timer;
          nextId = id;
        }
      }
      if (next === null || nextId === null) break;
      this.#now = next.due;
      if (next.intervalMs !== null) {
        next.due += next.intervalMs;
      } else {
        this.#timers.delete(nextId);
      }
      next.callback();
      await settleMicrotasks();
    }
    this.#now = target;
    await settleMicrotasks();
  }

  #schedule(
    callback: TimerCallback,
    delayMs: number,
    intervalMs: number | null,
  ): number {
    const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
    const id = this.#nextId++;
    this.#timers.set(id, {
      due: this.#now + delay,
      intervalMs,
      callback,
    });
    return id;
  }
}

/** 捕获 console.error，避免预期内的故障日志污染测试输出。 */
function captureConsoleError(): {
  entries: unknown[][];
  restore: () => void;
} {
  const original = console.error;
  const entries: unknown[][] = [];
  console.error = ((...args: unknown[]) => {
    entries.push(args);
  }) as typeof console.error;
  return {
    entries,
    restore: () => {
      console.error = original;
    },
  };
}

Deno.test("managed-task: 周期任务按间隔执行，stop 清理定时器且不再启动新轮次", async () => {
  const scheduler = new FakeScheduler();
  scheduler.install();
  try {
    let runs = 0;
    const task = startPeriodicTask({
      name: "demo",
      intervalMs: 100,
      run: () => {
        runs++;
      },
    });
    assertEquals(scheduler.activeTimerCount(), 1, "启动时应注册一个定时器");
    await scheduler.advance(100);
    assertEquals(runs, 1);
    await scheduler.advance(100);
    assertEquals(runs, 2);

    task.stop();
    assertEquals(scheduler.activeTimerCount(), 0, "stop 必须清理定时器");
    await scheduler.advance(1000);
    assertEquals(runs, 2, "stop 之后不得再执行新轮次");
    await task.done;
  } finally {
    scheduler.restore();
  }
});

Deno.test("managed-task: stop 不打断在途轮次，done 等待其结束", async () => {
  const scheduler = new FakeScheduler();
  scheduler.install();
  try {
    const round = deferred<void>();
    let runs = 0;
    const task = startPeriodicTask({
      name: "slow",
      intervalMs: 100,
      run: () => {
        runs++;
        return round.promise;
      },
    });
    await scheduler.advance(100);
    assertEquals(runs, 1, "第一轮应已开始");

    let doneSettled = false;
    void task.done.then(() => {
      doneSettled = true;
    });
    task.stop();
    await settleMicrotasks();
    assertEquals(doneSettled, false, "stop 不应让 done 在在途轮次结束前完成");

    await scheduler.advance(1000);
    assertEquals(runs, 1, "在途期间不得启动重叠轮次");
    assertEquals(doneSettled, false);

    round.resolve();
    await task.done;
    assertEquals(doneSettled, true, "done 必须在在途轮次结束后才完成");
  } finally {
    scheduler.restore();
  }
});

Deno.test("managed-task: 上一轮未结束时不会重叠启动", async () => {
  const scheduler = new FakeScheduler();
  scheduler.install();
  try {
    const pending: Deferred<void>[] = [];
    let runs = 0;
    const task = startPeriodicTask({
      name: "overlap",
      intervalMs: 10,
      run: () => {
        runs++;
        const round = deferred<void>();
        pending.push(round);
        return round.promise;
      },
    });
    await scheduler.advance(10);
    assertEquals(runs, 1);
    await scheduler.advance(10);
    await scheduler.advance(10);
    assertEquals(runs, 1, "上一轮未结束时不得启动新一轮");

    pending[0]!.resolve();
    await settleMicrotasks();
    await scheduler.advance(10);
    assertEquals(runs, 2, "上一轮结束后应恢复调度");

    pending[1]!.resolve();
    await settleMicrotasks();
    task.stop();
    await task.done;
  } finally {
    scheduler.restore();
  }
});

Deno.test("managed-task: 单轮失败不中断后续轮次且交给 onError", async () => {
  const scheduler = new FakeScheduler();
  scheduler.install();
  try {
    const errors: unknown[] = [];
    let runs = 0;
    const task = startPeriodicTask({
      name: "flaky",
      intervalMs: 100,
      run: () => {
        runs++;
        if (runs === 1) throw new Error("boom");
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    await scheduler.advance(100);
    await scheduler.advance(100);
    assertEquals(runs, 2, "失败后仍应继续后续轮次");
    assertEquals(errors.length, 1, "失败轮次必须上报 onError");
    task.stop();
    await task.done;
  } finally {
    scheduler.restore();
  }
});

Deno.test("managed-task: runImmediately 在启动时同步执行一轮", async () => {
  const scheduler = new FakeScheduler();
  scheduler.install();
  try {
    let runs = 0;
    const task = startPeriodicTask({
      name: "immediate",
      intervalMs: 10_000,
      runImmediately: true,
      run: () => {
        runs++;
      },
    });
    assertEquals(runs, 1, "runImmediately 必须同步启动第一轮");
    task.stop();
    assertEquals(scheduler.activeTimerCount(), 0);
    await task.done;
  } finally {
    scheduler.restore();
  }
});

Deno.test("managed-task: runImmediately 同步抛错不会逃逸，done 仍能完成", async () => {
  const scheduler = new FakeScheduler();
  scheduler.install();
  const consoleSpy = captureConsoleError();
  try {
    const errors: unknown[] = [];
    let task: ManagedTask | undefined;
    assertDoesNotThrow(() => {
      task = startPeriodicTask({
        name: "sync-throw",
        intervalMs: 1000,
        runImmediately: true,
        run: () => {
          throw new Error("sync boom");
        },
        onError: (error) => {
          errors.push(error);
        },
      });
    });
    assertEquals(errors.length, 1, "同步抛错必须交给 onError");
    task!.stop();
    await task!.done;
  } finally {
    consoleSpy.restore();
    scheduler.restore();
  }
});

Deno.test("managed-task: onError 自身抛错或返回 rejected Promise 不得泄漏", async () => {
  const scheduler = new FakeScheduler();
  scheduler.install();
  const consoleSpy = captureConsoleError();
  try {
    let syncTask: ManagedTask | undefined;
    assertDoesNotThrow(() => {
      syncTask = startPeriodicTask({
        name: "handler-throw",
        intervalMs: 1000,
        runImmediately: true,
        run: () => {
          throw new Error("run boom");
        },
        onError: () => {
          throw new Error("handler boom");
        },
      });
    });
    await settleMicrotasks();
    syncTask!.stop();
    await syncTask!.done;

    let asyncTask: ManagedTask | undefined;
    assertDoesNotThrow(() => {
      asyncTask = startPeriodicTask({
        name: "handler-reject",
        intervalMs: 1000,
        runImmediately: true,
        run: () => {
          throw new Error("run boom 2");
        },
        onError: () => Promise.reject(new Error("handler rejected")),
      });
    });
    await settleMicrotasks();
    asyncTask!.stop();
    await asyncTask!.done;

    assert(
      consoleSpy.entries.length >= 2,
      "错误处理器自身失败应降级为内部日志",
    );
  } finally {
    consoleSpy.restore();
    scheduler.restore();
  }
});

Deno.test("managed-task: 轮次等待 async onError 完成，done 不提前 resolve", async () => {
  const scheduler = new FakeScheduler();
  scheduler.install();
  try {
    const handler = deferred<void>();
    let handlerStarted = false;
    const task = startPeriodicTask({
      name: "async-handler",
      intervalMs: 1000,
      runImmediately: true,
      run: () => {
        throw new Error("run boom");
      },
      onError: () => {
        handlerStarted = true;
        return handler.promise;
      },
    });
    await settleMicrotasks();
    assertEquals(handlerStarted, true, "onError 应已开始执行");

    let doneSettled = false;
    void task.done.then(() => {
      doneSettled = true;
    });
    task.stop();
    await settleMicrotasks();
    assertEquals(
      doneSettled,
      false,
      "async onError 未完成时 done 不得提前 resolve",
    );

    handler.resolve();
    await task.done;
    assertEquals(doneSettled, true);
  } finally {
    scheduler.restore();
  }
});

Deno.test("managed-task: intervalMs 必须是正有限数", () => {
  const scheduler = new FakeScheduler();
  scheduler.install();
  try {
    for (
      const bad of [
        0,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        "100" as unknown as number,
      ]
    ) {
      assertThrows(
        () =>
          startPeriodicTask({
            name: "bad-interval",
            intervalMs: bad,
            run: () => {},
          }),
        RangeError,
        "intervalMs",
      );
    }
    assertEquals(scheduler.activeTimerCount(), 0, "非法间隔不得注册定时器");
  } finally {
    scheduler.restore();
  }
});

Deno.test("managed-task: adoptManagedTask 保留 done 拒绝并观察早期拒绝", async () => {
  const unhandled: unknown[] = [];
  const listener = (event: Event): void => {
    unhandled.push((event as PromiseRejectionEvent).reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", listener);
  try {
    const failure = new Error("legacy failure");
    const task = adoptManagedTask("legacy", {
      stop: () => {},
      done: Promise.reject(failure),
    });
    // 让出真实事件循环轮；若适配层没有立即观察，这里会记录到 unhandled。
    await flushEventLoopTurn();
    await flushEventLoopTurn();
    assertEquals(unhandled.length, 0, "适配层必须立即观察 done 的早期拒绝");

    const reason = await task.done.then(
      () => undefined,
      (error: unknown) => error,
    );
    assert(reason === failure, "done 必须保留原始拒绝原因，不得被吞掉");
  } finally {
    globalThis.removeEventListener("unhandledrejection", listener);
  }
});

Deno.test("managed-task: 组按逆序停止并等待在途完成", async () => {
  const group = createManagedTaskGroup();
  const order: string[] = [];
  const slowDone = deferred<void>();
  group.add({
    name: "first",
    stop: () => order.push("first"),
    done: Promise.resolve(),
  });
  group.add({
    name: "slow",
    stop: () => order.push("slow"),
    done: slowDone.promise,
  });
  group.add({
    name: "last",
    stop: () => order.push("last"),
    done: Promise.resolve(),
  });

  let shutdownSettled = false;
  const shuttingDown = group.shutdown().then(() => {
    shutdownSettled = true;
  });
  await settleMicrotasks();
  assertEquals(order, ["last", "slow", "first"], "必须按登记逆序停止");
  assertEquals(shutdownSettled, false, "必须等待 slow 的在途 done");

  slowDone.resolve();
  await shuttingDown;
  assertEquals(shutdownSettled, true);
  assertEquals(group.names(), ["first", "slow", "last"]);
});

Deno.test("managed-task: 重复 shutdown 幂等，且解构调用不依赖 this", async () => {
  const group = createManagedTaskGroup();
  let stops = 0;
  group.add({
    name: "only",
    stop: () => {
      stops++;
    },
    done: Promise.resolve(),
  });

  const { shutdown } = group;
  const first = shutdown();
  const second = shutdown();
  assertEquals(first, second, "重复 shutdown 必须返回同一个 Promise");
  await Promise.all([first, second]);
  assertEquals(stops, 1, "重复 shutdown 不得重复停止任务");
});

Deno.test("managed-task: doneAll 等待全部任务 settle 后再汇总失败", async () => {
  const group = createManagedTaskGroup();
  const slowDone = deferred<void>();
  const failedDone = deferred<void>();
  group.add({ name: "slow", stop: () => {}, done: slowDone.promise });
  group.add({ name: "failing", stop: () => {}, done: failedDone.promise });

  let doneAllSettled = false;
  const settled = group.doneAll().then(
    () => {
      doneAllSettled = true;
    },
    (error: unknown) => {
      doneAllSettled = true;
      return error;
    },
  );

  failedDone.reject(new Error("worker crashed"));
  await settleMicrotasks();
  assertEquals(
    doneAllSettled,
    false,
    "仍有任务未 settle 时 doneAll 不得提前结束",
  );

  slowDone.resolve();
  const error = await settled;
  assertEquals(doneAllSettled, true);
  assert(error instanceof Error);
  assert(error.message.includes("failing"), "汇总信息必须包含失败任务名");
});

Deno.test("managed-task: 单个 stop 抛错不阻断其余任务，doneAll 保留原始 cause", async () => {
  const consoleSpy = captureConsoleError();
  try {
    const group = createManagedTaskGroup();
    const stopFailure = new Error("stop exploded");
    const slowDone = deferred<void>();
    let okStopped = 0;

    group.add({
      name: "ok",
      stop: () => {
        okStopped++;
      },
      done: slowDone.promise,
    });
    group.add({
      name: "bad-stop",
      stop: () => {
        throw stopFailure;
      },
      done: Promise.resolve(),
    });

    assertDoesNotThrow(() => group.stopAll());
    assertEquals(okStopped, 1, "单个 stop 抛错不得阻断其余任务停止");

    let doneAllSettled = false;
    const settled = group.doneAll().then(
      () => {
        doneAllSettled = true;
      },
      (error: unknown) => {
        doneAllSettled = true;
        return error;
      },
    );
    await settleMicrotasks();
    assertEquals(doneAllSettled, false, "stop 抛错后仍必须等待全部 done");

    slowDone.resolve();
    const error = await settled;
    assert(error instanceof Error);
    assert(error.message.includes("bad-stop"));
    assert(
      error.cause === stopFailure,
      "单个失败必须把原始错误保留为 cause",
    );
  } finally {
    consoleSpy.restore();
  }
});

Deno.test("managed-task: 多个失败汇总为 AggregateError 并保留原始错误", async () => {
  const consoleSpy = captureConsoleError();
  try {
    const group = createManagedTaskGroup();
    const doneFailure = new Error("worker crashed");
    const stopFailure = new Error("stop exploded");

    group.add(adoptManagedTask("broken", {
      stop: () => {},
      done: Promise.reject(doneFailure),
    }));
    group.add({
      name: "bad-stop",
      stop: () => {
        throw stopFailure;
      },
      done: Promise.resolve(),
    });

    group.stopAll();
    const error = await group.doneAll().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert(error instanceof AggregateError, "多个失败必须使用 AggregateError");
    assert(error.message.includes("broken"));
    assert(error.message.includes("bad-stop"));
    assert(error.errors.includes(doneFailure), "必须保留 done 原始错误");
    assert(error.errors.includes(stopFailure), "必须保留 stop 原始错误");
  } finally {
    consoleSpy.restore();
  }
});

Deno.test("managed-task: stopAll/shutdown 之后 add 会先停止新任务再拒绝", async () => {
  const consoleSpy = captureConsoleError();
  try {
    const group = createManagedTaskGroup();
    group.add({
      name: "first",
      stop: () => {},
      done: Promise.resolve(),
    });
    group.stopAll();

    let lateStops = 0;
    const lateDone = deferred<void>();
    const late = adoptManagedTask("late", {
      stop: () => {
        lateStops++;
      },
      done: lateDone.promise,
    });

    assertThrows(() => group.add(late), Error, "late");
    assertEquals(lateStops, 1, "关闭后登记必须先停止调用方已启动的任务");
    assertEquals(group.names(), ["first"], "被拒绝的任务不得登记进任务组");
    lateDone.resolve();
    await group.doneAll();

    const groupAfterShutdown = createManagedTaskGroup();
    groupAfterShutdown.add({
      name: "only",
      stop: () => {},
      done: Promise.resolve(),
    });
    await groupAfterShutdown.shutdown();
    let lateStops2 = 0;
    const late2 = adoptManagedTask("late-2", {
      stop: () => {
        lateStops2++;
      },
      done: Promise.resolve(),
    });
    assertThrows(() => groupAfterShutdown.add(late2), Error, "late-2");
    assertEquals(lateStops2, 1, "shutdown 完成后登记同样要先停止新任务");
  } finally {
    consoleSpy.restore();
  }
});

Deno.test("managed-task: 日志设施抛错不影响停止其余任务与关闭后登记", async () => {
  const originalConsoleError = console.error;
  console.error = (() => {
    throw new Error("console broken");
  }) as typeof console.error;
  try {
    const group = createManagedTaskGroup();
    let okStopped = 0;
    group.add({
      name: "ok",
      stop: () => {
        okStopped++;
      },
      done: Promise.resolve(),
    });
    group.add({
      name: "bad-stop",
      stop: () => {
        throw new Error("stop boom");
      },
      done: Promise.resolve(),
    });

    assertDoesNotThrow(() => group.stopAll());
    assertEquals(okStopped, 1, "日志抛错不得阻断后续 stop");
    await assertRejects(() => group.doneAll(), Error, "bad-stop");

    let lateStopped = 0;
    const late = adoptManagedTask("late", {
      stop: () => {
        lateStopped++;
        throw new Error("late stop boom");
      },
      done: Promise.resolve(),
    });
    assertThrows(() => group.add(late), Error, "任务组已停止");
    assertEquals(lateStopped, 1, "关闭后登记仍需先尝试停止新任务");
  } finally {
    console.error = originalConsoleError;
  }
});

Deno.test("managed-task: doneAll 在空组上直接通过", async () => {
  const group = createManagedTaskGroup();
  await group.doneAll();
  assertEquals(group.names(), []);
});

Deno.test("managed-task: adoptManagedTask 的拒绝会被 doneAll 汇总", async () => {
  const group = createManagedTaskGroup();
  const failure = new Error("legacy failure");
  group.add(adoptManagedTask("legacy", {
    stop: () => {},
    done: Promise.reject(failure),
  }));
  await assertRejects(() => group.doneAll(), Error, "legacy");
});
