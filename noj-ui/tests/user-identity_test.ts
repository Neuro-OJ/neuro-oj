// deno-lint-ignore no-import-prefix
import { assertEquals, assertNotEquals } from 'jsr:@std/assert@^1';
import { userAvatarSrc, userIdentityLabel } from '../utils/user-identity.ts';

Deno.test('用户摘要：头像走站内端点，内容变化更新缓存键', () => {
  const user = { id: 'u/1', username: '学生', avatar_url: 'noj-storage://local/private?checksum_sha256=abc123' };
  assertEquals(userAvatarSrc(user), '/api/v1/users/u%2F1/avatar?v=abc123');
  assertNotEquals(
    userAvatarSrc(user),
    userAvatarSrc({ ...user, avatar_url: 'noj-storage://local/private?checksum_sha256=def456' }),
  );
  assertEquals(userAvatarSrc({ ...user, avatar_url: null }), undefined);
  assertEquals(userAvatarSrc({ ...user, state: 'deleted' }), undefined);
  assertEquals(userAvatarSrc({ id: 'u', username: 'name' }), undefined);
});
Deno.test('用户摘要：域是明确业务上下文，注销用户不保留原名', () => {
  const user = { id: 'u', username: 'student' };
  assertEquals(userIdentityLabel(user), 'student');
  assertEquals(userIdentityLabel(user, 'school-a'), 'student@school-a');
  assertEquals(userIdentityLabel({ ...user, state: 'deleted' }, 'school-a'), '已注销用户');
});
