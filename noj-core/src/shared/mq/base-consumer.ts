import { createConsumerRedis } from "./connection.ts";
import type { RedisClient } from "./connection.ts";
import {
  _resetSweepTargetsForTest,
  registerSweepTarget,
} from "./sweep-targets.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "mq"]);

/**
 * 断开 Redis 连接；同步 `void` 与异步 Promise 都兼容。
 *
 * 失败必须上抛：关闭后若连接仍可能存活，调用方（消费者池 / 任务组）需要
 * 以失败结束 done，不能谎报成功。
 */
async function disconnectOrThrow(
  redis: RedisClient,
  label: string,
): Promise<void> {
  try {
    await Promise.resolve(redis.disconnect());
  } catch (err) {
    logger.error("{label} Redis 断开失败", { label, err });
    throw new Error(`${label} Redis 断开失败`, { cause: err });
  }
}

export interface ConsumerOptions {
  queueName: string;
  logLabel: string; // e.g. "结果", "评测开始事件"
  aliveRef: { value: boolean };
  /**
   * 处理消息。正常返回表示成功并会从 processing 列表确认；
   * 抛出异常表示处理失败，调用方会将其重新投递回主队列。
   */
  handleMessage: (data: Record<string, unknown>) => Promise<void>;
  /** BRPOPLPUSH timeout in seconds */
  blpopTimeout?: number;
  /** 处理失败后立即重投；false 时仅由 sweeper 超时重投（默认 true）。 */
  requeueOnError?: boolean;
  /**
   * 本队列的 processing 超时（毫秒），超过即由 sweeper 重投。
   * 默认 15 分钟——足够长，避免正常长任务被误重投（重投是 at-least-once 语义）。
   */
  processingTimeoutMs?: number;
  /**
   * 测试注入：创建消费者专用 Redis 连接（默认 {@link createConsumerRedis}）。
   * 生产代码不得传入；仅用于在无 Redis 环境下验证生命周期语义。
   */
  createRedis?: () => RedisClient;
}

const DEFAULT_BLPOP_TIMEOUT = 10;
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
/** 单次启动最多重投多少条 processing 残留消息（防御性上限，避免异常积压拖慢启动）。 */
const MAX_STALE_REQUEUE_PER_START = 10_000;
/** 消费者未声明时的 processing 超时默认值（sweeper 兜底判定用）。 */
const DEFAULT_PROCESSING_TIMEOUT_MS = 15 * 60_000;

/**
 * 消费者句柄：既是启动函数（`handle()` 不返回，直到进程关闭），
 * 也带一个**只作用于本实例**的关闭入口。
 */
export interface ConsumerHandle {
  (): Promise<void>;
  /** 只停本消费者实例，不影响同进程内的其他消费者。 */
  requestShutdown(): void;
}

/**
 * 每个消费者实例独立的关闭状态。
 *
 * 修复记录（2026-09-12 架构评审 §2.5）：此前是**单个模块级布尔量**，被三个消费者
 * （评测结果 / 搜索索引 / 私信审核）共享——任一消费者请求关闭会同时停掉其余两个；
 * `shutdownSearchIndexConsumer()` 这种"只关自己"的语义实际会停掉全部消费者。
 * 现改为每实例独立标记；`requestConsumerShutdown()` 保留原语义（关停**全部**，
 * 用于进程优雅退出）。
 *
 * P2a（2026-10-20）：连接建立、重连退避与阻塞领取都注册**可移除**的等待者
 * （shutdownWaiters / sleepers）。每轮操作结束即注销，避免对整个生命周期长期
 * pending 的 Promise 反复 `.then` 造成 reaction 累积。
 */
interface ConsumerShutdownState {
  requested: boolean;
  /** 当前处于可中断睡眠中的唤醒函数集合。 */
  sleepers: Set<() => void>;
  /** 当前正在等待关闭信号的连接/领取操作唤醒函数集合。 */
  shutdownWaiters: Set<() => void>;
}

function createConsumerShutdownState(): ConsumerShutdownState {
  return {
    requested: false,
    sleepers: new Set(),
    shutdownWaiters: new Set(),
  };
}

/** 请求关闭一个消费者实例：置标记并唤醒所有等待者（幂等且清空注册）。 */
function requestStateShutdown(state: ConsumerShutdownState): void {
  state.requested = true;
  for (const wake of [...state.shutdownWaiters]) wake();
  state.shutdownWaiters.clear();
  for (const wake of [...state.sleepers]) wake();
  state.sleepers.clear();
}

/** 可移除的关闭等待：每轮连接/领取结束必须 {@link ShutdownWaiter.cancel}。 */
interface ShutdownWaiter {
  promise: Promise<void>;
  cancel(): void;
}

function waitForShutdown(state: ConsumerShutdownState): ShutdownWaiter {
  if (state.requested) {
    return { promise: Promise.resolve(), cancel: () => {} };
  }
  let settled = false;
  let resolveWait: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });
  const wake = (): void => {
    if (settled) return;
    settled = true;
    state.shutdownWaiters.delete(wake);
    resolveWait();
  };
  state.shutdownWaiters.add(wake);
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      state.shutdownWaiters.delete(wake);
      // 唤醒并释放本轮 race 的 reaction；调用方已不再关心该分支。
      resolveWait();
    },
  };
}

/**
 * 可中断睡眠：正常等待到时返回 true；被 `requestShutdown()` 打断返回 false。
 */
function sleepUnlessShutdown(
  state: ConsumerShutdownState,
  ms: number,
): Promise<boolean> {
  if (state.requested) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const wake = (): void => {
      clearTimeout(timer);
      state.sleepers.delete(wake);
      resolve(false);
    };
    const timer = setTimeout(() => {
      state.sleepers.delete(wake);
      resolve(true);
    }, ms);
    state.sleepers.add(wake);
  });
}

const activeConsumers = new Set<ConsumerShutdownState>();

/**
 * 已执行过 processing 兜底重投的队列（每进程每队列一次）。
 *
 * 见 `requeueStaleProcessing`：多副本/同队列多消费者时，只有第一个启动的消费者
 * 执行兜底，避免在兄弟消费者正在处理消息时把它们"抢"回主队列。
 */
const processingRequeuedQueues = new Set<string>();

/** 优雅关闭：请求**所有**消费者退出（BRPOPLPUSH 使未确认消息仍在 processing 列表）。 */
export function requestConsumerShutdown(): void {
  for (const state of activeConsumers) requestStateShutdown(state);
}

/** 测试用：复位关闭标记与 processing 兜底记录。 */
export function _resetConsumerShutdownForTest(): void {
  // 先真正请求关闭，唤醒并清理已注册的 sleeper / shutdown waiter（含计时器）；
  // 再清空注册表。不得把 requested 复位为 false，避免复活已停止的 state。
  for (const state of [...activeConsumers]) requestStateShutdown(state);
  activeConsumers.clear();
  processingRequeuedQueues.clear();
  _resetSweepTargetsForTest();
}

/** 测试专用：当前活跃消费者注册的等待者计数（验证每轮已注销，不随消息增长）。 */
export function _getConsumerShutdownWaiterCountForTest(): {
  states: number;
  shutdownWaiters: number;
  sleepers: number;
} {
  let shutdownWaiters = 0;
  let sleepers = 0;
  for (const state of activeConsumers) {
    shutdownWaiters += state.shutdownWaiters.size;
    sleepers += state.sleepers.size;
  }
  return { states: activeConsumers.size, shutdownWaiters, sleepers };
}

/**
 * 把本队列 `:processing` 中的残留消息重投回主队列（启动期兜底）。
 *
 * 背景（2026-09-12 架构评审 §2.5）：`BRPOPLPUSH` 会把消息移入 `:processing`，
 * 消费者在"已取走、未 ACK"窗口内进程被杀（或 Redis 连接中断）时消息就停留在
 * `:processing`。此前只有评测结果队列有 sweeper 超时扫描兜底，
 * `noj:search:index`（异步搜索索引投影，源域写库后 fire-and-forget 投递）与
 * `noj:review:dm` 的残留消息会**永久滞留且不可自愈**——搜索索引静默落后，
 * 直到有人手工跑 `search reindex`。
 *
 * 这里把兜底放进 `createConsumer` 基类，使**新接入的消费者自动获得该保障**，
 * 而不是要求每个队列都记得去改 sweeper 的队列清单。
 *
 * 约束：
 * - 每进程每队列只执行一次（`processingRequeuedQueues`）：避免同队列的兄弟消费者
 *   在重连重启时把正在被他人处理的消息抢回主队列；
 * - 用 `RPOPLPUSH` 原子搬运，不会丢消息；
 * - 失败只告警不阻断启动（sweeper 仍是第二道防线）。
 *
 * @returns 本次实际重投的消息条数（跳过或失败时为 0）
 */
export async function requeueStaleProcessing(
  redis: RedisClient,
  queueName: string,
  processingQueue: string,
  label: string,
): Promise<number> {
  if (processingRequeuedQueues.has(queueName)) return 0;
  try {
    let moved = 0;
    // processing 由 BRPOPLPUSH push 到左侧，故尾部是最早未确认的消息；
    // RPOPLPUSH 逐个搬到主队列头部，顺序得到保留（不依赖 LRANGE 快照）。
    for (;;) {
      const item = await redis.rpoplpush(processingQueue, queueName);
      if (!item) break;
      moved++;
      if (moved > MAX_STALE_REQUEUE_PER_START) {
        logger.warn(
          "{label} processing 残留消息超过单次重投上限，剩余部分交给 sweeper 兜底",
          {
            label,
            queue: processingQueue,
            limit: MAX_STALE_REQUEUE_PER_START,
          },
        );
        break;
      }
    }
    processingRequeuedQueues.add(queueName);
    if (moved > 0) {
      logger.warn("{label}检测到上次未确认的消息，已重投回主队列", {
        label,
        queue: queueName,
        moved,
      });
    }
    return moved;
  } catch (err) {
    logger.error("{label} processing 残留消息重投失败（等待 sweeper 兜底）", {
      label,
      queue: processingQueue,
      err,
    });
    return 0;
  }
}

/**
 * Create a consumer with automatic reconnection using exponential backoff.
 *
 * 可靠消费语义（NOJ-066/NOJ-074/NOJ-179）：
 * - BRPOPLPUSH 先把消息移入 processing 列表，处理成功后 LREM 确认；
 * - 处理抛错立即 RPUSH 回主队列并移除 processing 条目；
 * - **启动时**把本队列 processing 的残留消息重投回主队列（见 requeueStaleProcessing，
 *   2026-09-12 评审 §2.5：此前只有评测结果队列有 sweeper 兜底，
 *   `noj:search:index` / `noj:review:dm` 的残留消息会永久滞留，搜索索引静默落后）；
 * - 定期兜底由 sweeper 负责（超时重投）。
 *
 * @returns 启动函数（不返回，直到进程关闭）；带 `requestShutdown()` 可只停本实例。
 */
export function createConsumer(opts: ConsumerOptions): ConsumerHandle {
  const blpopTimeout = opts.blpopTimeout ?? DEFAULT_BLPOP_TIMEOUT;
  const label = opts.logLabel;
  const processingQueue = `${opts.queueName}:processing`;
  const requeueOnError = opts.requeueOnError ?? true;
  const createRedis = opts.createRedis ?? createConsumerRedis;
  const state = createConsumerShutdownState();
  activeConsumers.add(state);

  // 自动登记 sweeper 兜底目标：新增消费者无需再手工维护 sweeper 的队列清单。
  registerSweepTarget({
    queueName: opts.queueName,
    processingTimeoutMs: opts.processingTimeoutMs ??
      DEFAULT_PROCESSING_TIMEOUT_MS,
  });

  const startConsumerWithRetry = async function (): Promise<void> {
    let retryCount = 0;
    let fatalError: unknown = null;
    let hasFatalError = false;

    try {
      while (!state.requested) {
        opts.aliveRef.value = false;

        logger.info("{label}消费者正在启动...", { label });

        try {
          await runConsumer();
        } catch (err) {
          logger.error("{label}消费者异常退出", { label, err });
          // 连接清理失败等真正的退出错误必须上抛给 pool/group，不能吞掉后
          // 让 done 假装成功。
          fatalError = err;
          hasFatalError = true;
          break;
        }

        opts.aliveRef.value = false;
        if (state.requested) break;

        const delay = Math.min(
          INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount),
          MAX_RETRY_DELAY_MS,
        );
        retryCount++;

        logger.warn("{label}消费者将重启", {
          label,
          delay_ms: delay,
          retry: retryCount,
        });
        // 退避等待可被 requestShutdown() 立即打断（此前最长需等满 30s）。
        if (!(await sleepUnlessShutdown(state, delay))) break;
      }
    } finally {
      // 退出后从注册表移除：之后的全局关闭请求不再作用于已停止的实例。
      activeConsumers.delete(state);
    }
    if (hasFatalError) throw fatalError;
  };

  return Object.assign(startConsumerWithRetry, {
    requestShutdown: () => {
      requestStateShutdown(state);
    },
  });

  /**
   * 建立消费者连接。
   *
   * 连接可能因网络不可达而长时间重试；这里注册一个**本轮可移除**的关闭等待，
   * stop 时立即断开并返回 false。等待在 finally 中注销，避免长生命周期 Promise
   * 累积 reaction。
   *
   * @returns 连接是否可用且未被停止
   */
  async function connectRedisOrAbort(redis: RedisClient): Promise<boolean> {
    if (state.requested) return false;
    // 用 then 包裹以同时承接同步 throw 与异步 reject。
    const connectPromise = Promise.resolve().then(() => redis.connect());
    // stop 后 Promise.race 会放弃等待该 Promise；先挂 handler 避免未处理拒绝。
    connectPromise.catch(() => {});
    const stopWait = waitForShutdown(state);
    try {
      const outcome = await Promise.race([
        connectPromise.then(
          () => "connected" as const,
          (error: unknown) => ({ error }),
        ),
        stopWait.promise.then(() => "stopped" as const),
      ]);
      if (outcome === "stopped") {
        await disconnectOrThrow(redis, label);
        return false;
      }
      if (typeof outcome === "object" && "error" in outcome) {
        logger.error("{label}消费者 Redis 连接失败", {
          label,
          err: outcome.error,
        });
        await disconnectOrThrow(redis, label);
        return false;
      }
      return true;
    } finally {
      stopWait.cancel();
    }
  }

  async function runConsumer(): Promise<void> {
    const redis = createRedis();
    let primaryError: unknown = null;
    let hasPrimaryError = false;
    let closeError: unknown = null;
    let hasCloseError = false;
    try {
      await runConsumerLoop(redis);
    } catch (err) {
      primaryError = err;
      hasPrimaryError = true;
    } finally {
      // 统一 finalizer：连接/重连/领取/处理任一阶段异常退出都先标记失活并断开。
      opts.aliveRef.value = false;
      try {
        await disconnectOrThrow(redis, label);
      } catch (err) {
        closeError = err;
        hasCloseError = true;
      }
    }
    if (hasPrimaryError && hasCloseError) {
      throw new AggregateError(
        [primaryError, closeError],
        `${label}消费者退出且连接清理失败`,
      );
    }
    if (hasPrimaryError) throw primaryError;
    if (hasCloseError) throw closeError;
  }

  async function runConsumerLoop(redis: RedisClient): Promise<void> {
    if (!(await connectRedisOrAbort(redis))) return;

    await requeueStaleProcessing(
      redis,
      opts.queueName,
      processingQueue,
      label,
    );
    if (state.requested) return;

    opts.aliveRef.value = true;
    logger.info("{label}消费者启动，等待事件...", { label });

    while (!state.requested) {
      try {
        // 阻塞领取与 stop 竞速：BRPOPLPUSH 在服务端原子移入 processing，
        // 若 stop 抢先返回而消息随后才到达，消息仍在 processing，由 sweeper
        // 超时重投（at-least-once），绝不在这里误确认或丢弃。
        const popPromise = redis.brpoplpush(
          opts.queueName,
          processingQueue,
          blpopTimeout,
        );
        popPromise.catch(() => {});
        const stopWait = waitForShutdown(state);
        const outcome = await Promise.race([
          popPromise.then((value) => ({ kind: "message" as const, value })),
          stopWait.promise.then(() => ({ kind: "stopped" as const })),
        ]).finally(() => stopWait.cancel());
        if (outcome.kind === "stopped") break;
        const rawJson = outcome.value;
        if (!rawJson) continue;
        // 消息虽已返回，但 stop 已置位：不得再为新消息开启 handler，
        // 保留在 processing 由 sweeper 恢复。
        if (state.requested) break;

        let message: Record<string, unknown>;
        try {
          message = JSON.parse(rawJson);
        } catch {
          logger.error("{label} JSON 解析失败，移入死信队列", {
            label,
            raw: rawJson.slice(0, 512),
          });
          // 坏消息不能无限循环：先保留到 :dead 队列便于审计，再从 processing 移除。
          const deadQueue = `${opts.queueName}:dead`;
          try {
            await redis.rpush(deadQueue, rawJson);
          } catch (deadErr) {
            logger.error("{label} 写入死信队列失败", { label, err: deadErr });
          }
          await redis.lrem(processingQueue, 1, rawJson);
          continue;
        }

        try {
          // 已领取消息必须处理完：stop 只阻止领取下一条，不打断本条写库。
          await opts.handleMessage(message);
          const removed = await redis.lrem(processingQueue, 1, rawJson);
          if (removed === 0) {
            logger.warn(
              "{label} processing 确认未命中（可能已被 sweeper 重投）",
              {
                label,
                queue: processingQueue,
              },
            );
          }
        } catch (err) {
          logger.error("{label}消息处理失败，重新投递回主队列", {
            label,
            err,
          });
          if (requeueOnError) {
            // 先回主队列再清理 processing；若清理失败，sweeper 会再次重投（at-least-once）。
            try {
              await redis.rpush(opts.queueName, rawJson);
              await redis.lrem(processingQueue, 1, rawJson);
            } catch (requeueErr) {
              logger.error("{label}重投失败，等待 sweeper 兜底", {
                label,
                err: requeueErr,
              });
            }
          } else {
            await redis.lrem(processingQueue, 1, rawJson).catch(() => {});
          }
          // 避免 DB/Redis 持续故障时 hot loop；退避可被关闭请求打断。
          if (!(await sleepUnlessShutdown(state, 1000))) break;
        }
      } catch (err) {
        if (state.requested) break;
        logger.error("{label}消费者错误", { label, err });
        if (!(await sleepUnlessShutdown(state, 1000))) break;
      }
    }
  }
}
