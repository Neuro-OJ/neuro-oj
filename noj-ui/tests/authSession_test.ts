// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { parseAuthSession } from '../server/utils/auth-session.ts';

const validResponse = {
  data: {
    token: 'jwt-token',
    user: {
      id: 'user-1',
      username: 'alice',
      role: 'user',
      email: 'alice@example.com',
      must_change_password: false,
      tfa_enabled: false,
      is_admin: false,
    },
  },
};

Deno.test('parseAuthSession: 解析完整认证响应', () => {
  assertEquals(parseAuthSession(validResponse), validResponse.data);
});

Deno.test('parseAuthSession: 缺少 user 时返回 null', () => {
  assertEquals(
    parseAuthSession({ data: { token: 'jwt-token' } }),
    null,
  );
});

Deno.test('parseAuthSession: user 字段类型错误时返回 null', () => {
  assertEquals(
    parseAuthSession({
      data: {
        token: 'jwt-token',
        user: { ...validResponse.data.user, email: 42 },
      },
    }),
    null,
  );
});
