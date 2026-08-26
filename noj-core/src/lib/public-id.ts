/**
 * 公开标识（public identifier）工具。
 *
 * UUID 仅作为内部主键；对外使用 `前缀 + 8 位随机短码`。
 * 短码字符集刻意避开易混淆字符（0/o/1/i/l）。
 */

export const PUBLIC_ID_ALPHABET = "123456789abcdefghjkmnpqrstuvwxyz";

/** 判断是否为标准 UUID v4 字符串。 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(value);
}

/** 生成 `前缀-8位短码` 形式的公开标识。 */
export function generatePublicId(prefix: string, length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += PUBLIC_ID_ALPHABET[bytes[i] % PUBLIC_ID_ALPHABET.length];
  }
  return `${prefix}-${out}`;
}

/** 判断 value 是否为指定前缀的公开标识。 */
export function isPublicId(value: string, prefix: string): boolean {
  const re = new RegExp(`^${prefix}-[${PUBLIC_ID_ALPHABET}]{8}$`);
  return re.test(value);
}
