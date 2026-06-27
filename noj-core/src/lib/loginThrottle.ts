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
 * - 失败次数 ≥ 阈值时 SET loginlock:<user>，TTL = lockSeconds
 * - 登录成功时 DEL 清除
 */

import { getRedis } from "../mq/connection.ts";

const FAIL_TTL_SEC = 3600; // 失败计数 TTL：1 小时
const LOCK_TTL_SEC_DEFAULT = 3600; // 锁定时长：1 小时
const LOCK_THRESHOLD_DEFAULT = 10; // 连续 10 次失败触发锁定
const BACKOFF_SEC_DEFAULT = 15; // 每次失败 +15s

// 从环境变量读取可配置项
function envInt(name: string, def: number): number {
  const v = Deno.env.get(name);
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envBool(name: string, def: boolean): boolean {
  const v = Deno.env.get(name);
  if (v === undefined) return def;
  return v === "true" || v === "1";
}

// ── 失败计数（Redis）────────────────────────────────────

const failKey = (u: string) => `loginfail:${u.toLowerCase()}`;
const lockKey = (u: string) => `loginlock:${u.toLowerCase()}`;

/**
 * 记录一次登录失败，返回当前失败计数。
 * 失败次数达阈值时自动设置锁定标记。
 */
export async function recordLoginFailure(username: string): Promise<number> {
  const redis = getRedis();
  const threshold = envInt(
    "RATE_LIMIT_LOGIN_LOCK_THRESHOLD",
    LOCK_THRESHOLD_DEFAULT,
  );
  const lockSec = envInt(
    "RATE_LIMIT_LOGIN_LOCK_SECONDS",
    LOCK_TTL_SEC_DEFAULT,
  );

  const count = await redis.incr(failKey(username));
  if (count === 1) {
    await redis.expire(failKey(username), FAIL_TTL_SEC);
  }
  if (count >= threshold) {
    await redis.set(lockKey(username), "1", "EX", lockSec);
  }
  return count;
}

/** 检查账号是否被锁定 */
export async function isLoginLocked(username: string): Promise<boolean> {
  return (await getRedis().exists(lockKey(username))) === 1;
}

/** 登录成功时清除失败计数和锁定标记 */
export async function clearLoginFailure(username: string): Promise<void> {
  const redis = getRedis();
  await redis.del(failKey(username), lockKey(username));
}

// ── 退避（内存）────────────────────────────────────────

const inMemoryBackoff = new Map<string, number>(); // username → deadline (ms)

/** 退避时间（ms）= 失败次数 × backoffSec × 1000 */
function backoffMs(failCount: number): number {
  const backoffSec = envInt(
    "RATE_LIMIT_LOGIN_BACKOFF_SEC",
    BACKOFF_SEC_DEFAULT,
  );
  return Math.max(0, failCount) * backoffSec * 1000;
}

/**
 * 检查并应用退避：未到 deadline 则 sleep 到 deadline。
 * 在路由 handler 入口调用，sleep 不会泄漏给用户（被同步等待）。
 */
export async function applyLoginBackoff(username: string): Promise<void> {
  if (!username) return;
  const key = username.toLowerCase();
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
 */
export function recordLoginBackoff(
  username: string,
  failCount: number,
): void {
  if (!username) return;
  const key = username.toLowerCase();
  if (failCount <= 0) return;
  const ms = backoffMs(failCount);
  inMemoryBackoff.set(key, Date.now() + ms);
  // 兜底清理：deadline 之后 1 秒自动清除
  setTimeout(() => inMemoryBackoff.delete(key), ms + 1000);
}

/** 测试用：清空内存退避 Map */
export function _clearLoginBackoffForTest() {
  inMemoryBackoff.clear();
}

// ── 总开关（测试环境可关）─────────────────────────────────

/** 限流总开关。NOJ_ENV=test 或 RATE_LIMIT_ENABLED=false 时禁用 */
export function isRateLimitEnabled(): boolean {
  if (Deno.env.get("NOJ_ENV") === "test") return false;
  return envBool("RATE_LIMIT_ENABLED", true);
}
