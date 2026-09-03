/**
 * 公开标识（public identifier）工具。
 *
 * UUID 仅作为内部主键；对外使用 `前缀 + 8 位随机短码`。
 * 短码字符集刻意避开易混淆字符（0/o/1/i/l）。
 */

import { eq } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { getDb } from "./../shared/db/connection.ts";
import { NotFoundError } from "./../shared/base/errors.ts";

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

/**
 * 将 UUID 或 public_id 解析为内部 UUID；其它格式按主键兜底。
 *
 * @param table 含 `id` 与 `public_id` 列的表
 * @param idColumn 主键列
 * @param publicIdColumn public_id 列
 * @param prefix public_id 前缀（如 `ct`、`sub`）
 * @param value 用户传入的标识
 * @param notFoundMessage 未找到时抛出的错误消息
 * @returns 内部 UUID
 * @throws {NotFoundError} 标识不存在时
 */
export async function resolvePublicId(
  table: AnyPgTable,
  idColumn: AnyPgColumn,
  publicIdColumn: AnyPgColumn,
  prefix: string,
  value: string,
  notFoundMessage: string,
): Promise<string> {
  const db = getDb();
  if (isUuid(value)) return value;
  if (isPublicId(value, prefix)) {
    const rows = await db.select({ id: idColumn }).from(table)
      .where(eq(publicIdColumn, value)).limit(1);
    const row = rows[0] as { id: string } | undefined;
    if (!row) throw new NotFoundError(notFoundMessage);
    return row.id;
  }
  const byId = await db.select({ id: idColumn }).from(table)
    .where(eq(idColumn, value)).limit(1) as { id: string }[];
  if (!byId[0]) throw new NotFoundError(notFoundMessage);
  return byId[0].id;
}
