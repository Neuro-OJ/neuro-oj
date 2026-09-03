/**
 * 图片文件校验公共模块。
 *
 * 供头像上传（users-avatar.ts）与私信图片消息上传（messages）复用。
 * 校验链：扩展名 → Content-Type → 大小 → magic bytes → 三者一致性。
 * 拒绝 SVG（内嵌脚本 XSS 风险）。
 *
 * @module
 */

import { BadRequestError } from "./../shared/base/errors.ts";

/** 允许的图片 MIME 类型 */
export const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

/** 允许的图片扩展名（jpeg 与 jpg 均接受） */
export const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** magic bytes 推导的图片类型 → 标准 MIME */
export const IMAGE_MAGIC_MIME: Record<"png" | "jpeg" | "webp", string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** 图片文件校验结果：字节 + magic bytes 推导的图片类型 */
export interface ImageFile {
  bytes: Uint8Array;
  /** magic bytes 推导的类型（"png" | "jpeg" | "webp"） */
  type: "png" | "jpeg" | "webp";
}

/** 由 magic bytes 推导图片类型；无法识别返回 null */
export function detectImageType(
  bytes: Uint8Array,
): "png" | "jpeg" | "webp" | null {
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
export function imageTypeFromName(
  name: string,
): "png" | "jpeg" | "webp" | null {
  const m = IMAGE_EXT.exec(name);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === "png") return "png";
  if (ext === "webp") return "webp";
  return "jpeg"; // jpg / jpeg
}

/**
 * 校验图片文件并返回字节与 magic 推导类型。
 *
 * 校验链：扩展名 → Content-Type → 大小 → magic bytes，
 * 并要求扩展名 / Content-Type / magic bytes 三者推导的类型一致
 * （如 `a.png` + `image/png` + JPEG 字节 MUST 400）。
 * 拒绝 SVG（内嵌脚本 XSS 风险）。
 *
 * @param file 待校验文件
 * @param maxSize 大小上限（字节）
 * @param sizeLabel 大小限制的错误提示文案（如「2MB」）
 * @throws {BadRequestError} 任一项不满足
 */
export async function validateImageFile(
  file: File,
  maxSize: number,
  sizeLabel: string,
): Promise<ImageFile> {
  const nameType = imageTypeFromName(file.name);
  if (!nameType) {
    throw new BadRequestError("仅支持 png/jpeg/webp 图片");
  }
  if (file.type && !IMAGE_MIME.has(file.type)) {
    throw new BadRequestError("仅支持 png/jpeg/webp 图片");
  }
  if (file.size > maxSize) {
    throw new BadRequestError(`图片大小超过限制（最大 ${sizeLabel}）`);
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
  if (file.type && file.type !== IMAGE_MAGIC_MIME[magicType]) {
    throw new BadRequestError("文件 Content-Type 与图片内容不匹配");
  }
  return { bytes, type: magicType };
}
