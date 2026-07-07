/**
 * 登录失败限流（issue #73）。
 *
 * 三机制组合：
 * 1. **失败计数**：连续 N 次失败 → 锁定账号
 * 2. **失败锁定**：超过阈值后账号进入"冷却期"
 * 3. **失败退避**：当次响应**立即**返 401，但下次请求被 sleep 拦下
 *
 * 退避存储在内存（不阻塞响应、不依赖 Redis）：
 * - 失败时 set deadline = now + N × backoffSec
 * - 下次请求进入时检查 deadline，未到则 sleep
 * - 重启清零可接受（攻击者也重启了）
 *
 * 锁定存储在 Redis（跨进程一致）：
 * - 失败次数 ≥ 阈值时 SET <ns>lock:<user>，TTL = lockSeconds
 * - 登录成功时 DEL 清除
 *
 * Redis 不可用时采用 **fail-closed**：抛 ServiceUnavailableError (503)。
 *
 * Namespace 隔离（issue #75）：
 * - 默认 namespace `login` 用于登录端点
 * - change-password 端点使用 namespace `pwchange`，避免改密失败反锁 /login
 */

import { getRedis } from "../mq/connection.ts";
import { ServiceUnavailableError } from "./errors.ts";
import { isRateLimitEnabled, settingInt } from "./rateLimitEnv.ts";

const FAIL_TTL_SEC = 3600; // 失败计数 TTL：1 小时

/** 默认 namespace（登录端点） */
const DEFAULT_NAMESPACE = "login";

/** Namespace 校验：仅允许字母数字下划线短横线，防止 Redis key 注入 */
function safeNs(ns: string): string {
  return ns.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ── 失败计数（Redis）────────────────────────────────────

const failKey = (u: string, ns: string) =>
  `${safeNs(ns)}fail:${u.toLowerCase()}`;
const lockKey = (u: string, ns: string) =>
  `${safeNs(ns)}lock:${u.toLowerCase()}`;

/**
 * 记录一次登录失败，返回当前失败计数。
 * 失败次数达阈值时自动设置锁定标记。
 *
 * @param username 用户名 / UUID
 * @param namespace 命名空间（默认 "login"；change-password 用 "pwchange"）
 *
 * Redis 不可用时抛 ServiceUnavailableError（fail-closed）。
 */
export async function recordLoginFailure(
  username: string,
  namespace: string = DEFAULT_NAMESPACE,
): Promise<number> {
  if (!isRateLimitEnabled()) return 0;
  const threshold = settingInt("rate_limit_login_lock_threshold");
  const lockSec = settingInt("rate_limit_login_lock_seconds");

  try {
    const redis = getRedis();
    const count = await redis.incr(failKey(username, namespace));
    if (count === 1) {
      await redis.expire(failKey(username, namespace), FAIL_TTL_SEC);
    }
    if (count >= threshold) {
      await redis.set(lockKey(username, namespace), "1", "EX", lockSec);
    }
    return count;
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    throw new ServiceUnavailableError("登录限流服务暂时不可用");
  }
}

/**
 * 检查账号是否被锁定。
 * Redis 不可用时抛 ServiceUnavailableError
 */
export async function isLoginLocked(
  username: string,
  namespace: string = DEFAULT_NAMESPACE,
): Promise<boolean> {
  if (!isRateLimitEnabled()) return false;
  try {
    return (await getRedis().exists(lockKey(username, namespace))) === 1;
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    throw new ServiceUnavailableError("登录限流服务暂时不可用");
  }
}

/**
 * 登录成功时清除失败计数和锁定标记。
 * Redis 不可用时抛 ServiceUnavailableError
 */
export async function clearLoginFailure(
  username: string,
  namespace: string = DEFAULT_NAMESPACE,
): Promise<void> {
  if (!isRateLimitEnabled()) return;
  try {
    const redis = getRedis();
    await redis.del(failKey(username, namespace), lockKey(username, namespace));
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    throw new ServiceUnavailableError("登录限流服务暂时不可用");
  }
}

// ── 退避（内存）────────────────────────────────────────

/** 内存退避 Map：`<ns>::<username>` → deadline (ms) */
const inMemoryBackoff = new Map<string, number>();

/** 退避时间（ms）= 失败次数 × backoffSec × 1000 */
function backoffMs(failCount: number): number {
  const backoffSec = settingInt("rate_limit_login_backoff_sec");
  return Math.max(0, failCount) * backoffSec * 1000;
}

function backoffMapKey(username: string, ns: string): string {
  return `${safeNs(ns)}::${username.toLowerCase()}`;
}

/**
 * 检查并应用退避：未到 deadline 则 sleep 到 deadline。
 * 在路由 handler 入口调用，sleep 不会泄漏给用户（被同步等待）。
 *
 * 限流关闭时立即返回（不留任何副作用）。
 */
export async function applyLoginBackoff(
  username: string,
  namespace: string = DEFAULT_NAMESPACE,
): Promise<void> {
  if (!username) return;
  if (!isRateLimitEnabled()) return;
  const key = backoffMapKey(username, namespace);
  const deadline = inMemoryBackoff.get(key);
  if (!deadline) return;
  const now = Date.now();
  if (now >= deadline) {
    inMemoryBackoff.delete(key);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, deadline - now));
  inMemoryBackoff.delete(key);
}

/**
 * 失败时记录退避 deadline（不阻塞响应）。
 * 调用方应传入 recordLoginFailure() 返回的失败计数。
 *
 * 限流关闭时跳过记录，避免后续 sleep。
 */
export function recordLoginBackoff(
  username: string,
  failCount: number,
  namespace: string = DEFAULT_NAMESPACE,
): void {
  if (!username) return;
  if (!isRateLimitEnabled()) return;
  if (failCount <= 0) return;
  const key = backoffMapKey(username, namespace);
  const ms = backoffMs(failCount);
  inMemoryBackoff.set(key, Date.now() + ms);
  // 兜底清理：deadline 之后 1 秒自动清除
  setTimeout(() => inMemoryBackoff.delete(key), ms + 1000);
}

/** 测试用：清空内存退避 Map */
export function _clearLoginBackoffForTest() {
  inMemoryBackoff.clear();
}
