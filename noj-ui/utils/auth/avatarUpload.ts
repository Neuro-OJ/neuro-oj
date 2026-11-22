/** 头像上传前端校验。与 noj-core 的头像限制保持一致。 */

export const MAX_AVATAR_SIZE_BYTES = 2 * 1024 * 1024;
export const AVATAR_SIZE_ERROR = '头像大小超过限制（最大 2MB）';
export const AVATAR_TYPE_ERROR = '仅支持 png/jpeg/webp 图片';

const AVATAR_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AVATAR_FILE_NAME = /\.(png|jpe?g|webp)$/i;

/** 返回可直接展示给用户的校验错误；返回 null 表示文件可以上传。 */
export function getAvatarUploadError(
  file: Pick<File, 'name' | 'type' | 'size'>,
): string | null {
  if (!AVATAR_FILE_NAME.test(file.name) || !AVATAR_MIME_TYPES.has(file.type)) {
    return AVATAR_TYPE_ERROR;
  }
  if (file.size > MAX_AVATAR_SIZE_BYTES) return AVATAR_SIZE_ERROR;
  return null;
}
