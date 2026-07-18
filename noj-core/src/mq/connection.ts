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
/** PR-8：连接成功后清除 `_error` 的回调引用（用于测试清理 / 重连） */
let _clearErrorOnReady: (() => void) | null = null;

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
  // PR-8：自愈逻辑（不主动 disconnect，保留 ioredis 内部重连能力）
  if (_redis) {
    if (_redis.status === "ready") {
      // 客户端可用：清掉 stale error（双重保险）+ 返回
      if (_error) _error = null;
      return _redis;
    }
    // 客户端处于 connecting/reconnecting 等过渡态：直接返回，
    // 让 ioredis 内部 retryStrategy 处理（不抢断它）。
    // 同时清 _error 防止后续 getRedis() 立即抛错
    if (_error) _error = null;
    return _redis;
  }
  // _redis 为 null（首次调用或被显式置空）
  // _error 若残留则清掉，走下方创建路径
  if (_error) _error = null;

  try {
    const redisUrl = Deno.env.get("REDIS_URL") || "redis://127.0.0.1:6379/";
    // @ts-ignore - ioredis 构造函数类型在 Deno 中解析受限
    _redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false, // 断开时直接失败而非缓冲
      retryStrategy(times: number) {
        if (times > 5) return null; // 停止重试
        return Math.min(times * 200, 2000); // 指数退避
      },
      lazyConnect: true, // 延迟连接，手动调用 connect()
    });

    // PR-8：错误处理改为"瞬态 vs 持久"分离
    // - error 事件：仅在客户端尚未 ready 时记 _error（避免断连重连期间的 stale error 永久缓存）
    // - ready 事件：连接真正可用时立即清空 _error，下次 getRedis() 不会因历史错误而抛
    _redis!.on("error", (...args: unknown[]) => {
      const err = args[0];
      console.error(
        "Redis 连接错误:",
        err instanceof Error ? err.message : String(err),
      );
      // 仅在客户端尚未进入 ready 状态时累积错误（避免重连过程中误判）
      if (_redis?.status !== "ready") {
        _error = err instanceof Error ? err : new Error(String(err));
      }
    });

    _redis!.on("reconnecting", () => {
      console.log("Redis 正在重连...");
    });

    _redis!.on("connect", () => {
      console.log("Redis 连接已建立");
    });

    // PR-8：核心修复 —— ready 事件触发时清空 _error
    // 之前 _error 仅在 connect 事件清空，但 lazyConnect 模式下初次 connect 不触发 ready
    // 必须监听 ready 才能正确反映"连接可用"
    _clearErrorOnReady = () => {
      _error = null;
      console.log("Redis ready 状态确认，清空历史错误");
    };
    _redis!.on("ready", _clearErrorOnReady);

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
 *
 * PR-8：幂等性增强
 * - 已 ready：直接返回（避免无谓重连）
 * - 正在 connecting：等待现有连接尝试完成（避免 "already connecting" 错误）
 * - 未连接 / disconnected：触发新连接
 */
export async function connectRedis(): Promise<void> {
  try {
    const redis = getRedis();

    // 幂等：已 ready 直接返回（每次都 PING 会浪费一次 RTT，但确保 PONG 语义）
    if (redis.status === "ready") {
      const pong = await redis.ping();
      if (pong !== "PONG") {
        throw new Error(`Redis PING 返回异常: ${pong}`);
      }
      console.log("Redis 连接验证通过（复用现有连接）");
      return;
    }

    // 正在 connecting：等就绪，避免重复 connect() 抛错
    if (redis.status === "connecting" || redis.status === "connect") {
      // 等到 ready 或 5s 超时
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        if (redis.status === "ready") break;
        if (redis.status === "end" || redis.status === "close") break;
      }
      if (redis.status !== "ready") {
        throw new Error(`Redis 连接等待超时（status=${redis.status}）`);
      }
      console.log("Redis 连接验证通过（等待已有连接）");
      return;
    }

    // 其他状态（disconnected/end）：触发新连接
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
 * 重置 Redis 单例状态（测试用）。
 *
 * ## PR-8 语义
 *
 * - 清空 `_error` 与 ready 监听器引用
 * - 清空 `_redis` 引用，让下次 `getRedis()` 按当前 `REDIS_URL` 重建
 *
 * **关键**：不调用 `_redis.disconnect()` —— 这是同步阻塞操作，
 * Deno 测试并行执行时会延迟所有并行测试。最坏情况下 _redis 在后台
 * 自然被 GC + ioredis retryStrategy 自动清理。
 *
 * 用 `getRedis()` 重建前的最后状态：
 * - 测试切换 fake URL：成功（下次 getRedis 用 fake URL 创建新 client）
 * - 测试仅切换状态：成功（`_redis=null` 让 getRedis 走正常创建逻辑）
 */
export function resetRedisForTest() {
  if (_clearErrorOnReady) {
    _clearErrorOnReady = null;
  }
  // 清空引用：让下次 getRedis() 按当前 REDIS_URL 重建
  _redis = null;
  _error = null;
}

/**
 * 仅清错误缓存，**保留** `_redis` 引用不动。
 *
 * 与 `resetRedisForTest` 的区别：本函数只清 `_error`，不触碰 `_redis`。
 * 用于"清理异常状态但不打断当前客户端"的场景。
 */
export function clearRedisErrorForTest() {
  _error = null;
}

/**
 * 用一个全新的 Redis 客户端替换全局单例（mq fake-Redis 测试专用）。
 *
 * 与 `resetRedisForTest()` 的区别：此函数**直接替换** `_redis` 引用，
 * 让 `getRedis()` 立即返回新 client。调用方负责断开旧 client（如果有）。
 *
 * 不接受 null 参数（要清空用 `replaceRedisClientForTest(null)` 也明确语义）。
 *
 * @param client 新 Redis 客户端（已连接或 lazy 均可）
 */
export function replaceRedisClientForTest(client: RedisClient | null) {
  _redis = client;
  _error = null;
  _clearErrorOnReady = null;
}

/**
 * 替换为新的 Redis URL 对应的 client（mq 测试切换 fake URL 场景）。
 *
 * 该函数会：
 * 1. 断开并清掉旧 client（如果有）
 * 2. 用新 URL 创建新 client（lazyConnect）
 * 3. 替换全局 `_redis` 引用
 *
 * 用法：
 * ```ts
 * await swapRedisURLForTest("redis://127.0.0.1:6399/");
 * // ... 测试代码使用 getRedis() 拿到的就是新 client
 * await swapRedisURLForTest(null); // 恢复（自动用 REDIS_URL 环境变量重新连接）
 * ```
 *
 * @param url 新 URL，传 null 表示恢复到进程默认 `REDIS_URL`
 */
export function swapRedisURLForTest(url: string | null): void {
  if (_redis) {
    if (_clearErrorOnReady) {
      try {
        _redis.off("ready", _clearErrorOnReady);
      } catch { /* ignore */ }
      _clearErrorOnReady = null;
    }
    try {
      _redis.disconnect();
    } catch { /* ignore */ }
    _redis = null;
  }
  _error = null;

  if (url === null) {
    // 恢复到默认 URL（重新触发 getRedis 创建）
    return;
  }

  // 用新 URL 替换
  const prevUrl = Deno.env.get("REDIS_URL");
  Deno.env.set("REDIS_URL", url);
  _redis = null; // 确保 getRedis 重新创建
  // 不调用 connect（保持 lazy），调用方自行 redis.connect()
  // 恢复环境变量（避免副作用）
  if (prevUrl === undefined) Deno.env.delete("REDIS_URL");
  else Deno.env.set("REDIS_URL", prevUrl);
}
