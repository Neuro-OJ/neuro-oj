import bcrypt from "bcryptjs";

/**
 * bcrypt 哈希的盐轮数。
 *
 * 历史值为 10（OWASP 2025+ 已不推荐）。默认值 12 符合 OWASP 最低建议，
 * 在 2026 年的硬件水平下，单次哈希约 250-300ms。
 * 可通过环境变量 BCRYPT_SALT_ROUNDS 覆盖（E2E 测试环境设为 4 以加速）。
 */
const SALT_ROUNDS = parseInt(Deno.env.get("BCRYPT_SALT_ROUNDS") || "12", 10);

/**
 * 对明文密码进行 bcrypt 哈希。
 * @param plain - 明文密码
 * @returns bcrypt 哈希字符串
 */
export async function hashPassword(plain: string): Promise<string> {
  return await bcrypt.hash(plain, SALT_ROUNDS);
}

/**
 * 验证明文密码是否与 bcrypt 哈希匹配。
 * @param plain - 明文密码
 * @param hash - bcrypt 哈希字符串
 * @returns 是否匹配
 */
export async function comparePassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return await bcrypt.compare(plain, hash);
}
