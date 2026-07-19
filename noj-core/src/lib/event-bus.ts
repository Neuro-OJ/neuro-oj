import { createPubSubRedis, getRedis } from "../mq/connection.ts";
import type { RedisClient } from "../mq/connection.ts";
import { logger } from "./logging.ts";

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
  /** 统计数据变更：noj:events:stats */
  stats: `${EVENT_CHANNEL_PREFIX}stats`,
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
 * Redis Pub/Sub 连接实例引用（供重连时复用）。
 */
let _subscriberRedis: ReturnType<typeof createPubSubRedis> | null = null;

/**
 * 在 Redis 连接上注册 pmessage 分发监听器。
 */
function registerPmessageHandler(redis: RedisClient): void {
  // @ts-ignore: ioredis pmessage 事件参数类型与 Deno 类型定义不完全兼容
  redis.on("pmessage", (
    _pattern: string,
    channel: string,
    message: string,
  ) => {
    dispatchToLocalListeners(channel, message);
  });
  // ioredis 在某些 Deno 版本中可能使用 message 而非 pmessage
  // @ts-ignore: ioredis 在某些环境下使用 message 而非 pmessage，两者都注册以兼容
  redis.on("message", (channel: string, message: string) => {
    dispatchToLocalListeners(channel, message);
  });
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

/**
 * 执行 PSUBSCRIBE 并标记就绪。
 */
async function doSubscribe(redis: RedisClient): Promise<void> {
  await redis.psubscribe(`${EVENT_CHANNEL_PREFIX}*`);
  subscriberReady = true;
  logger.info("事件订阅者已订阅 noj:events:*");
}

/**
 * 初始化 Redis Pub/Sub 事件订阅者。
 *
 * 创建独立 Redis 连接，PSUBSCRIBE 到所有 noj:events:* 频道，
 * 收到消息后分发到本地 EventEmitter（localListeners）。
 *
 * ioredis 在 Pub/Sub 模式下断开重连后不会自动重新 PSUBSCRIBE，
 * 因此需要监听 reconnect 事件并重新订阅。
 *
 * 此函数在 main.ts 启动评测结果消费者之后调用。
 */
export function initEventSubscriber(): void {
  const redis = createPubSubRedis();
  _subscriberRedis = redis;

  // 先注册 pmessage 监听器再连接/订阅，避免竞态
  registerPmessageHandler(redis);

  // 后台启动并订阅
  (async () => {
    try {
      await redis.connect();
      logger.info("事件订阅者 Redis 连接成功");
      await doSubscribe(redis);
    } catch (err) {
      subscriberReady = false;
      logger.error("事件订阅者初始化失败", { err });
    }
  })();

  // ioredis 重连后自动重新 PSUBSCRIBE
  // @ts-ignore: ioredis reconnect 事件在类型定义中未声明
  redis.on("reconnect", () => {
    logger.info("事件订阅者 Redis 重连中...");
    subscriberReady = false;
  });

  // @ts-ignore: ioredis ready 事件（重连成功后触发）类型未声明
  redis.on("ready", async () => {
    logger.info("事件订阅者 Redis 已就绪，重新订阅...");
    try {
      await doSubscribe(redis);
    } catch (err) {
      logger.error("事件订阅者重连后订阅失败", { err });
    }
  });
}
