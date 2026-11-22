/** utils/avatarUpload.ts 单元测试。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  AVATAR_SIZE_ERROR,
  AVATAR_TYPE_ERROR,
  getAvatarUploadError,
  MAX_AVATAR_SIZE_BYTES,
} from '../utils/avatarUpload.ts';

function avatarFile(
  overrides: Partial<Pick<File, 'name' | 'type' | 'size'>> = {},
): Pick<File, 'name' | 'type' | 'size'> {
  return {
    name: 'avatar.png',
    type: 'image/png',
    size: 1024,
    ...overrides,
  };
}

Deno.test('avatarUpload: 合法格式和 2MB 边界允许上传', () => {
  assertEquals(getAvatarUploadError(avatarFile({ size: MAX_AVATAR_SIZE_BYTES })), null);
  assertEquals(
    getAvatarUploadError(avatarFile({ name: 'avatar.webp', type: 'image/webp' })),
    null,
  );
});

Deno.test('avatarUpload: 超过 2MB 返回明确错误文案', () => {
  assertEquals(
    getAvatarUploadError(avatarFile({ size: MAX_AVATAR_SIZE_BYTES + 1 })),
    AVATAR_SIZE_ERROR,
  );
});

Deno.test('avatarUpload: 非法扩展名或 MIME 类型返回类型错误', () => {
  assertEquals(getAvatarUploadError(avatarFile({ name: 'avatar.gif' })), AVATAR_TYPE_ERROR);
  assertEquals(getAvatarUploadError(avatarFile({ type: 'image/svg+xml' })), AVATAR_TYPE_ERROR);
});
