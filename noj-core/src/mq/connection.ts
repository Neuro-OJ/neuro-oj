import Redis from "ioredis";

let _redis: Redis | null = null;
let _error: Error | null = null;

/**
 * 获取 Redis 连接实例（单例模式）。
 * 首次调用时根据环境变量 REDIS_URL 创建连接。
 * 失败时记录错误但不崩溃，health 端点可查询状态。
 */
export function getRedis(): Redis {
  if (_error) throw _error;
  if (_redis) return _redis;

  try {
    const redisUrl = Deno.env.get("REDIS_URL") || "redis://127.0.0.1:6379/";
    _redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false, // 断开时直接失败而非缓冲
      retryStrategy(times) {
        if (times > 5) return null; // 停止重试
        return Math.min(times * 200, 2000); // 指数退避
      },
      lazyConnect: true, // 延迟连接，手动调用 connect()
    });

    // 错误处理
    _redis.on("error", (err) => {
      console.error("Redis 连接错误:", err.message);
      _error = err;
    });

    _redis.on("reconnecting", () => {
      console.log("Redis 正在重连...");
    });

    _redis.on("connect", () => {
      console.log("Redis 连接已建立");
      _error = null; // 重连成功时清除历史错误
    });

    return _redis;
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
 * 返回 { ok: true } 或 { ok: false, error: string }。
 */
export function checkRedisHealth(): { ok: boolean; error?: string } {
  if (_error) {
    return { ok: false, error: _error.message };
  }
  if (!_redis || _redis.status !== "ready") {
    return {
      ok: false,
      error: `连接状态: ${_redis?.status ?? "未初始化"}`,
    };
  }
  return { ok: true };
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
