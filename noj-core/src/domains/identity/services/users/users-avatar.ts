// ── 头像（issue #229）────────────────────────────────────────
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "../../../../db/connection.ts";
import { users } from "../../../../db/schema.ts";
import { BadRequestError, NotFoundError } from "../../../../lib/errors.ts";
import { getStorageProvider } from "../../../../lib/storage/factory.ts";
import {
  isStorageUrl,
  parseStorageUrl,
} from "../../../../lib/storage/types.ts";

/** 头像大小上限（2MB） */
export const MAX_AVATAR_SIZE = 2 * 1024 * 1024;

/** 允许的头像 MIME 类型 */
const AVATAR_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

/** 允许的头像扩展名（jpeg 与 jpg 均接受） */
const AVATAR_EXT = /\.(png|jpe?g|webp)$/i;

/** magic bytes 推导的图片类型 → 标准 MIME */
const AVATAR_MAGIC_MIME: Record<"png" | "jpeg" | "webp", string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** 头像文件校验结果：字节 + magic bytes 推导的图片类型 */
interface AvatarFile {
  bytes: Uint8Array;
  /** magic bytes 推导的类型（"png" | "jpeg" | "webp"） */
  type: "png" | "jpeg" | "webp";
}

/** 由 magic bytes 推导图片类型；无法识别返回 null */
function detectImageType(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isPng) return "png";
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  if (isJpeg) return "jpeg";
  const isWebp = bytes.length >= 12 &&
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  if (isWebp) return "webp";
  return null;
}

/** 文件名扩展名 → 图片类型；无扩展名返回 null */
function imageTypeFromName(name: string): "png" | "jpeg" | "webp" | null {
  const m = AVATAR_EXT.exec(name);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === "png") return "png";
  if (ext === "webp") return "webp";
  return "jpeg"; // jpg / jpeg
}

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
async function validateAvatarFile(file: File): Promise<AvatarFile> {
  const nameType = imageTypeFromName(file.name);
  if (!nameType) {
    throw new BadRequestError("仅支持 png/jpeg/webp 图片");
  }
  if (file.type && !AVATAR_MIME.has(file.type)) {
    throw new BadRequestError("仅支持 png/jpeg/webp 图片");
  }
  if (file.size > MAX_AVATAR_SIZE) {
    throw new BadRequestError("头像大小超过限制（最大 2MB）");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const magicType = detectImageType(bytes);
  if (!magicType) {
    throw new BadRequestError("文件不是有效的图片");
  }
  // 扩展名与内容一致性（spec：扩展名/Content-Type 不匹配 MUST 400）
  if (nameType !== magicType) {
    throw new BadRequestError("文件扩展名与图片内容不匹配");
  }
  // Content-Type 与内容一致性（file.type 为空时跳过）
  if (file.type && file.type !== AVATAR_MAGIC_MIME[magicType]) {
    throw new BadRequestError("文件 Content-Type 与图片内容不匹配");
  }
  return { bytes, type: magicType };
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
    AVATAR_MAGIC_MIME[type],
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
