/**
 * JWT 撤销存储（issue #75 撤销机制）。
 *
 * 撤销的 jti 写入 Redis：
 * - Key：`jwt:revoked:{jti}`
 * - Value：撤销时间戳（ISO 字符串，便于审计追溯）
 * - TTL：与 token 剩余有效期一致（过期后 Redis 自动清理）
 *
 * `verifyToken` 之后必须调用 `isJtiRevoked()`，命中则抛 UnauthorizedError。
 * 撤销来源：
 * - 用户主动 /logout
 * - 用户 /change-password（旧 token 立即失效）
 * - 用户被 ban / 角色降级（管理员主动撤销，PR-2 接入）
 *
 * Redis 不可用时**关闭 fail-closed**：authMiddleware 抛 ServiceUnavailableError
 * (503)，避免绕过撤销检查。与 loginIpRateLimit 的 fail-closed 一致。
 */
import { getRedis } from "../mq/connection.ts";
import { ServiceUnavailableError } from "./errors.ts";

/** Redis Key 前缀。命名空间 `jwt:revoked:*` 与其他用途隔离。 */
const KEY_PREFIX = "jwt:revoked:";

/**
 * 撤销指定 jti，写入 Redis。
 *
 * @param jti - JWT 唯一标识
 * @param ttlSeconds - 撤销条目在 Redis 的存活时间（秒）
 *                    应等于 token 的剩余有效期，过期后无需再保留
 * @throws {ServiceUnavailableError} Redis 不可用
 */
export async function revokeJti(
  jti: string,
  ttlSeconds: number,
): Promise<void> {
  if (!jti) return;
  // TTL ≤ 0 视为立即过期，无需写入（防御性，正常不会发生）
  if (ttlSeconds <= 0) return;
  try {
    const redis = getRedis();
    const value = new Date().toISOString();
    await redis.set(KEY_PREFIX + jti, value, "EX", ttlSeconds);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ServiceUnavailableError(`撤销令牌失败：${msg}`);
  }
}

/**
 * 检查 jti 是否已被撤销。
 *
 * @param jti - JWT 唯一标识
 * @returns true 表示已撤销
 * @throws {ServiceUnavailableError} Redis 不可用（fail-closed）
 */
export async function isJtiRevoked(jti: string): Promise<boolean> {
  if (!jti) return false;
  try {
    const redis = getRedis();
    const result = await redis.exists(KEY_PREFIX + jti);
    return result > 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // fail-closed：Redis 不可用时无法确认撤销状态，必须拒绝请求
    // 避免被偷 token 通过撤销机制失效后还能继续使用
    throw new ServiceUnavailableError(`校验令牌撤销状态失败：${msg}`);
  }
}

/**
 * 从 JWT payload 计算剩余有效期（秒）。
 *
 * 用于 `revokeJti` 设置 Redis TTL，使撤销条目与 token 同步过期。
 * 避免长期保留已自然过期的撤销条目浪费 Redis 内存。
 *
 * @param exp - JWT payload 中的 exp（秒，Unix 时间戳）
 * @returns 剩余秒数；已过期返 0；payload 缺失返 0
 */
export function remainingTtlFromExp(exp: number | undefined): number {
  if (!exp || typeof exp !== "number") return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const remaining = exp - nowSec;
  return remaining > 0 ? remaining : 0;
}
