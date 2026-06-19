import bcrypt from "bcryptjs";

/** bcrypt 哈希的盐轮数。数值越高越安全，但耗时更久。 */
const SALT_ROUNDS = 10;

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
