// ── 头像（issue #229）────────────────────────────────────────
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import { users } from "./../../../../shared/db/schema.ts";
import { NotFoundError } from "./../../../../shared/base/errors.ts";
import { getStorageProvider } from "../../../../lib/storage/factory.ts";
import {
  isStorageUrl,
  parseStorageUrl,
} from "../../../../lib/storage/types.ts";
import {
  IMAGE_MAGIC_MIME,
  type ImageFile,
  validateImageFile,
} from "../../../../lib/image-validation.ts";

/** 头像大小上限（2MB） */
export const MAX_AVATAR_SIZE = 2 * 1024 * 1024;

/**
 * 校验头像文件并返回字节与 magic 推导类型。
 *
 * 校验链：扩展名 → Content-Type → 大小 → magic bytes，
 * 并要求扩展名 / Content-Type / magic bytes 三者推导的类型一致
 * （如 `a.png` + `image/png` + JPEG 字节 MUST 400）。
 * 拒绝 SVG（内嵌脚本 XSS 风险）。
 *
 * @throws {BadRequestError} 任一项不满足
 */
function validateAvatarFile(file: File): Promise<ImageFile> {
  return validateImageFile(file, MAX_AVATAR_SIZE, "2MB");
}

/**
 * 判断两个存储 URL 是否指向同一存储对象。
 *
 * 以 provider + key 为判等依据（同一 key 视为同一对象，校验和差异忽略）：
 * S3 固定 key 模式下替换头像会覆盖同一对象，新旧 URL 仅 checksum
 * 不同，直接比较字符串会误判为不同对象并删除刚写入的新文件。
 * provider 不同（local vs s3）即使 key 相同也属于不同对象；
 * 非 `noj-storage://` URL（脏数据）短路返回 false，不抛错。
 */
export function sameStorageObject(a: string, b: string): boolean {
  if (!isStorageUrl(a) || !isStorageUrl(b)) return false;
  const pa = parseStorageUrl(a);
  const pb = parseStorageUrl(b);
  return pa.provider === pb.provider && pa.key === pb.key;
}

/**
 * 清理旧头像文件（仅当无其他用户仍引用同一存储对象时）。
 *
 * local 内容寻址模式下，字节相同的头像共享同一存储对象（URL 相同），
 * 直接删除会破坏仍引用它的其他用户的头像；S3 固定 key 按用户隔离
 * （avatar/<userId>.<ext>），不可能共享，无需检查。
 * 仍有引用时跳过删除——内容寻址下文件按内容哈希命名，保留不产生孤儿。
 *
 * @param db 数据库连接
 * @param userId 当前操作的用户（排除其自身引用）
 * @param oldUrl 待清理的旧头像 URL
 * @throws 沿用 provider.delete 的异常语义（调用方按需静默）
 */
async function deleteAvatarIfUnreferenced(
  db: ReturnType<typeof getDb>,
  userId: string,
  oldUrl: string,
): Promise<void> {
  const provider = await getStorageProvider();
  if (parseStorageUrl(oldUrl).provider === "local") {
    const refs = await db.select({ id: users.id }).from(users)
      .where(and(eq(users.avatar_url, oldUrl), ne(users.id, userId)))
      .limit(1);
    if (refs.length > 0) return; // 仍有其他用户引用，跳过删除
  }
  await provider.delete(oldUrl);
}

/**
 * 上传/替换头像。
 *
 * 顺序：先存新文件 → 更新 DB → 清理旧文件。
 * 内容寻址下同图 URL 相同，固定 key 模式下同 key 不误删。
 */
export async function updateUserAvatar(
  userId: string,
  file: File,
): Promise<{ avatar_url: string | null }> {
  const { bytes, type } = await validateAvatarFile(file);
  const provider = await getStorageProvider();
  // 1. 先存新文件（key 带用户 id 与扩展名，供 S3 模式的 Content-Type 推断）
  const ext = type === "png" ? "png" : type === "webp" ? "webp" : "jpg";
  const newUrl = await provider.put(
    `avatar/${userId}.${ext}`,
    bytes,
    IMAGE_MAGIC_MIME[type],
  );

  const db = getDb();
  // 2. 更新 DB（先取旧 URL 用于清理）
  const old = await db.select({ avatar_url: users.avatar_url }).from(users)
    .where(eq(users.id, userId)).limit(1);
  if (!old[0]) {
    throw new NotFoundError("用户不存在");
  }
  await db.update(users)
    .set({ avatar_url: newUrl, updated_at: new Date().toISOString() })
    .where(eq(users.id, userId));

  // 3. 清理旧文件（幂等；同 key 同一对象不误删；local 共享引用不误删）
  const oldUrl = old[0].avatar_url;
  if (oldUrl && !sameStorageObject(oldUrl, newUrl)) {
    try {
      await deleteAvatarIfUnreferenced(db, userId, oldUrl);
    } catch {
      // 旧文件不存在时静默忽略
    }
  }
  return { avatar_url: newUrl };
}

/**
 * 删除头像：清空字段 + 删除文件（幂等）。
 */
export async function clearUserAvatar(
  userId: string,
): Promise<{ avatar_url: null }> {
  const db = getDb();
  const old = await db.select({ avatar_url: users.avatar_url }).from(users)
    .where(eq(users.id, userId)).limit(1);
  if (!old[0]) {
    throw new NotFoundError("用户不存在");
  }
  await db.update(users)
    .set({ avatar_url: null, updated_at: new Date().toISOString() })
    .where(eq(users.id, userId));

  const oldUrl = old[0].avatar_url;
  if (oldUrl) {
    try {
      await deleteAvatarIfUnreferenced(db, userId, oldUrl);
    } catch {
      // 幂等：文件不存在时静默忽略
    }
  }
  return { avatar_url: null };
}

/**
 * 读取头像字节与元数据。
 *
 * @throws {NotFoundError} 用户无头像
 */
export async function getUserAvatarBytes(
  userId: string,
): Promise<{ bytes: Uint8Array; contentType: string; etag: string }> {
  const db = getDb();
  const row = await db.select({ avatar_url: users.avatar_url }).from(users)
    .where(eq(users.id, userId)).limit(1);
  const url = row[0]?.avatar_url;
  if (!url) {
    throw new NotFoundError("该用户未设置头像");
  }
  const provider = await getStorageProvider();
  const bytes = await provider.get(url);
  const parsed = parseStorageUrl(url);
  const contentType = /\.png$/i.test(parsed.key)
    ? "image/png"
    : /\.webp$/i.test(parsed.key)
    ? "image/webp"
    : "image/jpeg";
  const etag = parsed.checksumSha256
    ? `"${parsed.checksumSha256}"`
    : `"${parsed.key}"`;
  return { bytes, contentType, etag };
}
