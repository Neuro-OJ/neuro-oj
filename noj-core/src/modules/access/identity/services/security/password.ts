import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { users } from "../../../../../shared/db/schema.ts";

/** 密码与会话版本始终在同一条 UPDATE 中变更，撤销全部旧会话。 */
export function passwordUpdate(
  passwordHash: string,
  mustChangePassword: boolean,
) {
  return {
    password_hash: passwordHash,
    session_version: sql`${users.session_version} + 1`,
    must_change_password: mustChangePassword,
    updated_at: new Date().toISOString(),
  };
}

/**
 * bcrypt 哈希的盐轮数。
 *
 * 历史值为 10（OWASP 2025+ 已不推荐）。默认值 12 符合 OWASP 最低建议，
 * 在 2026 年的硬件水平下，单次哈希约 250-300ms。
 * 可通过环境变量 BCRYPT_SALT_ROUNDS 覆盖（E2E 测试环境设为 4 以加速）。
 */
const SALT_ROUNDS = parseInt(Deno.env.get("BCRYPT_SALT_ROUNDS") || "12", 10);

/**
 * 管理员签发的临时密码使用的盐轮数（不高于 {@link SALT_ROUNDS}）。
 *
 * 临时密码强制首次登录修改，改密时按 SALT_ROUNDS 重新哈希；系统生成的临时密码
 * 有 144 位随机熵，cost 10（约 65ms）足以抵御离线暴力破解。批量开号最多 500 行，
 * 若沿用 cost 12（约 260ms/次）需要 2 分钟以上，会超过反向代理常见的 60 秒超时。
 */
export const TEMPORARY_PASSWORD_SALT_ROUNDS = Math.min(SALT_ROUNDS, 10);

/**
 * 对管理员签发的临时密码进行 bcrypt 哈希（账号必须同时设置
 * `must_change_password = true`）。
 * @param plain - 明文临时密码
 * @returns bcrypt 哈希字符串
 */
export function hashTemporaryPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, TEMPORARY_PASSWORD_SALT_ROUNDS);
}

/**
 * 对明文密码进行 bcrypt 哈希。
 * @param plain - 明文密码
 * @returns bcrypt 哈希字符串
 */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

/**
 * 验证明文密码是否与 bcrypt 哈希匹配。
 * @param plain - 明文密码
 * @param hash - bcrypt 哈希字符串
 * @returns 是否匹配
 */
export function comparePassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
