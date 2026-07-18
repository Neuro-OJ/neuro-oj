import IORedis from "ioredis";

/**
 * Redis 客户端的最小接口定义。
 * ioredis 的类型在 Deno 中解析受限（类/命名空间冲突），
 * 因此定义本地接口仅声明实际使用的方法。
 */
export interface RedisClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ping(): Promise<string>;
  quit(): Promise<string>;
  status: string;
  lpush(...args: (string | number)[]): Promise<number>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  psubscribe(...patterns: string[]): Promise<unknown>;
  brpop(...args: (string | number)[]): Promise<[string, string] | null>;
  lrange(...args: (string | number)[]): Promise<string[]>;
  llen(...args: (string | number)[]): Promise<number>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  // 限流/计数（issue #73）
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  pttl(key: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  set(
    key: string,
    value: string,
    mode?: "EX" | "PX" | "NX" | "XX",
    ttl?: number,
  ): Promise<unknown>;
  pipeline(): RedisPipeline;
}

interface RedisPipeline {
  incr(key: string): RedisPipeline;
  pttl(key: string): RedisPipeline;
  pexpire(key: string, ms: number): RedisPipeline;
  exec(): Promise<[Error | null, unknown][]>;
}

let _redis: RedisClient | null = null;
let _error: Error | null = null;

/**
 * 获取 Redis 连接实例（单例模式）。
 * 首次调用时根据环境变量 REDIS_URL 创建连接。
 * 失败时记录错误但不崩溃，health 端点可查询状态。
 */
/**
 * 创建专用的 Redis 消费者连接。
 *
 * 结果消费者使用 BRPOP 阻塞等待，会独占连接通道。
 * 因此需要独立的连接实例，不与 pushJudgeTask（LPUSH）共享。
 */
export function createConsumerRedis(): RedisClient {
  const redisUrl = Deno.env.get("REDIS_URL") || "redis://127.0.0.1:6379/";
  // @ts-ignore - ioredis 构造函数类型在 Deno 中解析受限
  const redis = new IORedis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false,
    retryStrategy(times: number) {
      // 指数退避：100ms → 200ms → 400ms → ... → 上限 30s
      // 永不返回 null，确保连接断开时持续尝试重连
      return Math.min(Math.pow(2, times) * 100, 30000);
    },
    lazyConnect: true,
  });

  redis.on("error", (...args: unknown[]) => {
    const err = args[0];
    console.error(
      "消费者 Redis 连接错误:",
      err instanceof Error ? err.message : String(err),
    );
  });

  return redis;
}

/**
 * 创建专用的 Redis Pub/Sub 订阅者连接。
 *
 * Pub/Sub 模式（PSUBSCRIBE/SUBSCRIBE）会独占 Redis 连接通道，
 * 因此需要独立的连接实例，不与 LPUSH/BRPOP 共享。
 * 配置无限重试，确保事件订阅的持久性。
 */
export function createPubSubRedis(): RedisClient {
  const redisUrl = Deno.env.get("REDIS_URL") || "redis://127.0.0.1:6379/";
  // @ts-ignore - ioredis 构造函数类型在 Deno 中解析受限
  const redis = new IORedis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false,
    retryStrategy(times: number) {
      // 指数退避：100ms → 200ms → 400ms → ... → 上限 30s
      // 永不返回 null，确保 Pub/Sub 订阅持久连接
      return Math.min(Math.pow(2, times) * 100, 30000);
    },
    lazyConnect: true,
  });

  redis.on("error", (...args: unknown[]) => {
    const err = args[0];
    console.error(
      "Pub/Sub Redis 连接错误:",
      err instanceof Error ? err.message : String(err),
    );
  });

  return redis;
}

export function getRedis(): RedisClient {
  if (_error) throw _error;
  if (_redis) return _redis!;

  try {
    const redisUrl = Deno.env.get("REDIS_URL") || "redis://127.0.0.1:6379/";
    // @ts-ignore - ioredis 构造函数类型在 Deno 中解析受限
    _redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
      retryStrategy(times: number) {
        if (times > 5) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });
    _redis!.on("error", (...args: unknown[]) => {
      const err = args[0];
      console.error(
        "Redis 连接错误:",
        err instanceof Error ? err.message : String(err),
      );
      _error = err instanceof Error ? err : new Error(String(err));
    });
    _redis!.on("reconnecting", () => {
      console.log("Redis 正在重连...");
    });
    _redis!.on("connect", () => {
      console.log("Redis 连接已建立");
      _error = null;
    });
    return _redis!;
  } catch (err) {
    _error = err instanceof Error ? err : new Error(String(err));
    console.error("Redis 初始化失败:", _error.message);
    throw _error;
  }
}

/**
 * 连接并验证 Redis 服务。
 * 在启动时调用，执行 PING 确认连接有效。
 */
export async function connectRedis(): Promise<void> {
  try {
    const redis = getRedis();
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== "PONG") {
      throw new Error(`Redis PING 返回异常: ${pong}`);
    }
    console.log("Redis 连接验证通过");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Redis 连接失败:", message);
    throw err;
  }
}

/**
 * 检查 Redis 连接是否正常。
 * 连接状态为 ready 时执行实际 PING 命令验证。
 * 返回 { ok: true } 或 { ok: false, error: string }。
 */
export async function checkRedisHealth(): Promise<
  { ok: boolean; error?: string }
> {
  if (_error) {
    return { ok: false, error: _error.message };
  }
  if (!_redis || _redis.status !== "ready") {
    return {
      ok: false,
      error: `连接状态: ${_redis?.status ?? "未初始化"}`,
    };
  }

  try {
    const pong = await _redis.ping();
    if (pong !== "PONG") {
      return { ok: false, error: `PING 返回异常: ${pong}` };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * 重置 Redis 连接状态（测试用）。
 */
export function resetRedisForTest() {
  if (_redis) {
    _redis.disconnect();
    _redis = null;
  }
  _error = null;
}
