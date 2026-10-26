import { createPubSubRedis, getRedis } from "../mq/connection.ts";
import type { RedisClient } from "../mq/connection.ts";
import type { ManagedTask } from "../runtime/managed-task.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "sse"]);
import { recordSseEvent } from "./sse-events.ts";

/**
 * Redis Pub/Sub 频道前缀。
 * 与 MQ 队列名（noj:judge:*）明确区分，避免命名冲突。
 */
const EVENT_CHANNEL_PREFIX = "noj:events:";

/**
 * 事件频道名称常量。
 */
export const Channels = {
  /** 单个提交状态变更：noj:events:submission:<submission_id> */
  submission(id: string): string {
    return `${EVENT_CHANNEL_PREFIX}submission:${id}`;
  },
  /** 全局队列变更：noj:events:queue */
  queue: `${EVENT_CHANNEL_PREFIX}queue`,
  /** 用户私信通知：noj:events:user:<user_id> */
  user(id: string): string {
    return `${EVENT_CHANNEL_PREFIX}user:${id}`;
  },
  /** 域内教学进度刷新提示；推送前仍须检查具体作业访问权限。 */
  education(domainId: string): string {
    return `${EVENT_CHANNEL_PREFIX}education:${domainId}`;
  },
  /** 竞赛排名变更：noj:events:contest:<contest_id>:ranking */
  contestRanking(id: string): string {
    return `${EVENT_CHANNEL_PREFIX}contest:${id}:ranking`;
  },
  /** 竞赛新提交：noj:events:contest:<contest_id>:submission */
  contestSubmission(id: string): string {
    return `${EVENT_CHANNEL_PREFIX}contest:${id}:submission`;
  },
  /** 统计数据变更：noj:events:stats */
  stats: `${EVENT_CHANNEL_PREFIX}stats`,
  /** 公告变更：noj:events:announcements */
  announcements: `${EVENT_CHANNEL_PREFIX}announcements`,
  /**
   * 系统设置变更（**跨副本缓存失效**）：noj:events:settings
   *
   * 2026-09-12 评审 §2.6：`system-settings.ts` 的配置缓存是进程内的，此前失效只做
   * 本地 `cache.delete()`，没有任何跨副本失效通道——多副本下"管理员改了设置，
   * 其余副本永不感知"。发布/订阅本频道后，各副本收到即清本地缓存。
   */
  settings: `${EVENT_CHANNEL_PREFIX}settings`,
} as const;

/**
 * 发布事件到 Redis Pub/Sub 频道。
 *
 * fire-and-forget 模式：不 await 调用方，不抛出异常。
 * 发布失败仅记录日志，不阻塞评测等主流程。
 *
 * 当 EventBus 订阅者未就绪时跳过发布（消息投递到 Redis 但不保证接收方），
 * 丢失的事件由前端的轮询 fallback 补齐。
 */
export function publishEvent(channel: string, message: string): void {
  if (!subscriberReady) {
    return;
  }
  try {
    const redis = getRedis();
    if (redis.status !== "ready") {
      logger.warn("publishEvent 跳过：Redis 未就绪", { status: redis.status });
      return;
    }
    redis.publish(channel, message).catch((err: unknown) => {
      logger.error("publishEvent 失败", { channel, err });
    });
  } catch (err) {
    logger.error("publishEvent 异常", { channel, err });
  }
}

/**
 * 写入 SSE 事件日志并发布 Redis 通知。
 *
 * 返回事件 id；调用方可在 payload 中附带 seq 供客户端去重。
 * 写库失败不阻塞 Redis 通知（记录日志后继续发布）。
 */
export async function publishSseEvent(
  channel: string,
  payload: unknown,
): Promise<number> {
  let id = 0;
  try {
    id = await recordSseEvent(channel, payload);
  } catch (err) {
    logger.error("recordSseEvent 失败", { channel, err });
  }
  publishEvent(channel, JSON.stringify({ ...(payload as object), seq: id }));
  return id;
}

/**
 * 事务提交成功后发送 Redis 通知，事件 id 来自事务内 `recordSseEventTx`。
 *
 * 与 `sse-events.recordSseEventTx` 配对使用；payload 会附带 `seq` 供客户端去重。
 * 仅负责实时扇出，不重复写库。
 */
export function publishSseEventAfterTx(
  channel: string,
  payload: unknown,
  eventId: number,
): void {
  publishEvent(
    channel,
    JSON.stringify({ ...(payload as object), seq: eventId }),
  );
}

/**
 * 本地 EventEmitter 回调类型。
 */
type EventCallback = (channel: string, message: string) => void;

/**
 * 本地事件监听器注册表。
 * key: Redis 频道名（全名），value: Set<回调函数>
 */
const localListeners = new Map<string, Set<EventCallback>>();

/**
 * 订阅本地 EventEmitter 事件。
 *
 * @param channel - Redis 频道名（全名，如 "noj:events:submission:<id>"）
 * @param callback - 收到事件时的回调
 * @returns unsubscribe 函数——调用后取消订阅
 */
export function onEvent(
  channel: string,
  callback: EventCallback,
): () => void {
  if (!localListeners.has(channel)) {
    localListeners.set(channel, new Set());
  }
  localListeners.get(channel)!.add(callback);

  return () => {
    const callbacks = localListeners.get(channel);
    if (callbacks) {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        localListeners.delete(channel);
      }
    }
  };
}

/**
 * EventSubscriber 就绪标志。
 * 在 PSUBSCRIBE 成功后设为 true。
 * publishEvent 检查此标志，避免订阅未就绪时丢消息。
 */
let subscriberReady = false;

/**
 * 在 Redis 连接上注册 pmessage 分发监听器。
 *
 * @param redis 专用 Pub/Sub 连接
 * @param isActive 是否仍应分发；stop 后返回 false，阻止关闭后的事件进入回调
 * @returns 注销监听器的函数
 */
function registerPmessageHandler(
  redis: RedisClient,
  isActive: () => boolean = () => true,
): () => void {
  // 参数显式收窄为 unknown：ioredis 的 pmessage/message 事件在 Deno 类型定义
  // 中不完全兼容，统一在运行时校验字符串。
  const onPmessage = (...args: unknown[]): void => {
    if (!isActive()) return;
    const [, channel, message] = args;
    if (typeof channel === "string" && typeof message === "string") {
      dispatchToLocalListeners(channel, message);
    }
  };
  // ioredis 在某些 Deno 版本中可能使用 message 而非 pmessage，两者都注册以兼容。
  const onMessage = (...args: unknown[]): void => {
    if (!isActive()) return;
    const [channel, message] = args;
    if (typeof channel === "string" && typeof message === "string") {
      dispatchToLocalListeners(channel, message);
    }
  };
  redis.on("pmessage", onPmessage);
  redis.on("message", onMessage);
  return () => {
    try {
      redis.off("pmessage", onPmessage);
    } catch {
      // 连接已关闭等场景下 off 失败可忽略。
    }
    try {
      redis.off("message", onMessage);
    } catch {
      // 同上
    }
  };
}

function dispatchToLocalListeners(channel: string, message: string): void {
  const exactCallbacks = localListeners.get(channel);
  if (exactCallbacks) {
    for (const cb of exactCallbacks) {
      try {
        cb(channel, message);
      } catch (err) {
        logger.error("事件回调异常", { channel, err });
      }
    }
  }
}

/** 事件订阅者启动选项（`createRedis` 仅供测试注入）。 */
export interface EventSubscriberOptions {
  /** 测试注入：创建专用 Pub/Sub 连接（默认 {@link createPubSubRedis}）。 */
  createRedis?: () => RedisClient;
}

/**
 * 初始化 Redis Pub/Sub 事件订阅者。
 *
 * 创建独立 Redis 连接，PSUBSCRIBE 到所有 noj:events:* 频道，
 * 收到消息后分发到本地 EventEmitter（localListeners）。
 *
 * 生命周期（P2a，2026-10-20）：
 * - `stop()` 立即停止分发与再订阅，并在后台关闭专用连接（幂等）；
 * - `done` 等待初始化尝试、订阅循环与连接关闭全部结束；
 * - 首次 connect 与 `ready` 事件按连接代次去重，保证每个连接只 PSUBSCRIBE
 *   一次；`reconnecting`/`close` 自增代次，旧代次晚到不得影响新代次；
 * - quit 失败或处于 connecting 时用 disconnect 兜底，避免 done 永不 resolve。
 *
 * ioredis 在 Pub/Sub 模式下断开重连后不会自动重新 PSUBSCRIBE，
 * 因此需要监听 ready 事件并重新订阅。
 *
 * 此函数在 main.ts 启动评测结果消费者之后调用。
 */
export function initEventSubscriber(
  options: EventSubscriberOptions = {},
): ManagedTask {
  const redis = (options.createRedis ?? createPubSubRedis)();

  let stopped = false;
  /**
   * 连接代次：reconnecting/close/end 时自增。旧代次的 psubscribe 晚到完成
   * 不得把新代次误标为已订阅。
   */
  let generation = 0;
  let subscribedGeneration: number | null = null;
  /** 每个代次最多一个在途订阅；旧代次在途不阻塞新代次。 */
  const inFlightSubscribes = new Map<number, Promise<void>>();
  const pendingSubscribes = new Set<Promise<void>>();

  // stop 请求信号：done 在 stop 之前保持 pending（长时间运行的订阅者语义）。
  let resolveStopRequested: () => void = () => {};
  const stopRequested = new Promise<void>((resolve) => {
    resolveStopRequested = resolve;
  });

  /** 连接关闭 Promise；stop 时创建，失败会 reject（不得谎报成功）。 */
  let closePromise: Promise<void> | null = null;

  // 先注册 pmessage 监听器再连接/订阅，避免竞态；stop 后门控关闭。
  const disposePmessage = registerPmessageHandler(redis, () => !stopped);

  const subscribeIfNeeded = (reason: string): Promise<void> => {
    if (stopped) return Promise.resolve();
    const gen = generation;
    const inFlight = inFlightSubscribes.get(gen);
    if (subscribedGeneration === gen) return Promise.resolve();
    if (inFlight) return inFlight;

    const attempt = (async () => {
      try {
        await redis.psubscribe(`${EVENT_CHANNEL_PREFIX}*`);
        // 代次校验：旧连接晚到的完成绝不能把新代次标记为已订阅。
        if (stopped || gen !== generation) return;
        subscribedGeneration = gen;
        subscriberReady = true;
        logger.info("事件订阅者已订阅 noj:events:*", {
          reason,
          generation: gen,
        });
      } catch (err) {
        // 仅当前代次的真实订阅失败才记录；关闭/旧代次取消不算故障。
        if (!stopped && gen === generation) {
          subscriberReady = false;
          logger.error("事件订阅者订阅失败", { reason, generation: gen, err });
        }
      }
    })();
    inFlightSubscribes.set(gen, attempt);
    pendingSubscribes.add(attempt);
    const settle = (): void => {
      if (inFlightSubscribes.get(gen) === attempt) {
        inFlightSubscribes.delete(gen);
      }
      pendingSubscribes.delete(attempt);
    };
    // attempt 内部已捕获全部错误；仍用双分支 handler 避免意外未处理拒绝。
    void attempt.then(settle, settle);
    return attempt;
  };

  const onReady = (): void => {
    if (stopped) return;
    logger.info("事件订阅者 Redis 已就绪，确保已订阅...");
    void subscribeIfNeeded("ready");
  };
  const onReconnecting = (): void => {
    generation++;
    subscribedGeneration = null;
    subscriberReady = false;
    logger.info("事件订阅者 Redis 重连中...");
  };
  const onClosed = (): void => {
    generation++;
    subscribedGeneration = null;
    subscriberReady = false;
  };

  redis.on("ready", onReady);
  redis.on("reconnecting", onReconnecting);
  redis.on("close", onClosed);
  redis.on("end", onClosed);

  // 初始连接：connect 成功后主动订阅一次；随后 ready 事件因当前代次已订阅
  // 会跳过，保证首次连接不会重复 PSUBSCRIBE。用 then 包裹以承接同步 throw。
  const connectAttempt = Promise.resolve().then(() => redis.connect());
  // connectSettled 始终 resolve（错误已记录），done 等待的是“真正收尾”而非提前放行。
  const connectSettled: Promise<void> = connectAttempt.then(
    () => {
      if (stopped) return;
      logger.info("事件订阅者 Redis 连接成功");
      return subscribeIfNeeded("connect");
    },
    (err: unknown) => {
      subscriberReady = false;
      if (!stopped) logger.error("事件订阅者初始化失败", { err });
    },
  );
  connectSettled.catch(() => {});

  const detachHandlers = (): void => {
    try {
      redis.off("ready", onReady);
    } catch {
      // 忽略
    }
    try {
      redis.off("reconnecting", onReconnecting);
    } catch {
      // 忽略
    }
    try {
      redis.off("close", onClosed);
    } catch {
      // 忽略
    }
    try {
      redis.off("end", onClosed);
    } catch {
      // 忽略
    }
    disposePmessage();
  };

  /**
   * 关闭专用连接：先摘除 ready/pmessage 监听器（停止分发与再订阅），
   * 再 quit；quit 失败/超时用 disconnect 兜底。若 quit 与 disconnect 都失败，
   * Promise 以 AggregateError reject，由 done 暴露真实原因。
   */
  const startClose = (): Promise<void> => {
    if (closePromise) return closePromise;
    subscriberReady = false;
    detachHandlers();
    const closing = (async () => {
      const quitPromise = Promise.resolve().then(() => redis.quit());
      // quit 超时后仍可能晚些 reject；先挂 handler 避免未处理拒绝。
      quitPromise.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          quitPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("SSE 订阅者 quit 超时")),
              2_000,
            );
          }),
        ]);
      } catch (quitErr) {
        logger.error("事件订阅者 quit 失败，使用 disconnect 兜底", {
          err: quitErr,
        });
        try {
          // ioredis 的 disconnect() 可能同步返回 void，必须用 Promise.resolve 包裹。
          await Promise.resolve(redis.disconnect());
        } catch (disconnectErr) {
          logger.error("事件订阅者 disconnect 兜底也失败", {
            err: disconnectErr,
          });
          throw new AggregateError(
            [quitErr, disconnectErr],
            "SSE 订阅者连接关闭失败",
          );
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        subscriberReady = false;
      }
    })();
    closePromise = closing;
    // 先挂 no-op handler：stop 后到 doneAll 真正 await 之间不得触发 unhandled。
    closing.catch(() => {});
    return closing;
  };

  return {
    name: "sse-event-subscriber",
    stop: () => {
      if (stopped) return;
      stopped = true;
      subscriberReady = false;
      startClose();
      resolveStopRequested();
    },
    done: (async () => {
      // 等待 stop 请求、连接关闭，以及 connect / 订阅尝试真正收尾。
      // 关闭失败通过 closePromise 的拒绝暴露，绝不谎报 done 成功。
      await stopRequested;
      const pending = [...pendingSubscribes];
      await Promise.allSettled([
        connectSettled,
        ...pending,
        startClose(),
      ]);
      await startClose();
    })(),
  };
}

/**
 * 测试专用：设置 subscriberReady 标志。
 * 仅测试使用，生产代码不得调用。
 */
export function _setSubscriberReadyForTest(ready: boolean): void {
  subscriberReady = ready;
}

/**
 * 测试专用：直接向本地监听器分发消息，绕过 Redis。
 * 仅测试使用，生产代码不得调用。
 */
export function _dispatchToLocalListenersForTest(
  channel: string,
  message: string,
): void {
  dispatchToLocalListeners(channel, message);
}
