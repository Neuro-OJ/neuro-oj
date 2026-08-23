/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { parseAuthSession } from '../server/utils/auth-session.ts';

const validResponse = {
  data: {
    token: 'jwt-token',
    user: {
      id: 'user-1',
      username: 'alice',
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

Deno.test('parseAuthSession: 缺少 token 时返回 null', () => {
  assertEquals(
    parseAuthSession({ data: { user: validResponse.data.user } }),
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

Deno.test('parseAuthSession: 缺少 is_admin 时返回 null', () => {
  const { is_admin: _isAdmin, ...user } = validResponse.data.user;
  assertEquals(
    parseAuthSession({ data: { token: 'jwt-token', user } }),
    null,
  );
});

Deno.test('parseAuthSession: 自定义角色仍以 is_admin 为准', () => {
  const response = {
    data: {
      ...validResponse.data,
      user: { ...validResponse.data.user, role: 'content-manager', is_admin: true },
    },
  };
  assertEquals(parseAuthSession(response)?.user.is_admin, true);
});

Deno.test('parseAuthSession: 保留有头像用户的头像地址', () => {
  const response = {
    data: {
      ...validResponse.data,
      user: { ...validResponse.data.user, avatar_url: 'noj-storage://local/avatar' },
    },
  };
  assertEquals(parseAuthSession(response)?.user.avatar_url, 'noj-storage://local/avatar');
});

Deno.test('parseAuthSession: 保留无头像用户的 null 状态', () => {
  const response = {
    data: {
      ...validResponse.data,
      user: { ...validResponse.data.user, avatar_url: null },
    },
  };
  assertEquals(parseAuthSession(response)?.user.avatar_url, null);
});

Deno.test('parseAuthSession: 兼容缺少头像字段的旧响应', () => {
  assertEquals(parseAuthSession(validResponse)?.user.avatar_url, undefined);
});

Deno.test('parseAuthSession: 头像字段类型错误时返回 null', () => {
  const response = {
    data: {
      ...validResponse.data,
      user: { ...validResponse.data.user, avatar_url: 42 },
    },
  };
  assertEquals(parseAuthSession(response), null);
});

Deno.test('parseAuthSession: admin 角色名不能覆盖 false 标记', () => {
  const response = {
    data: {
      ...validResponse.data,
      user: { ...validResponse.data.user, role: 'admin' },
    },
  };
  assertEquals(parseAuthSession(response)?.user.is_admin, false);
});
