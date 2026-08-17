/**
 * utils/isAdminUser.ts 单元测试。
 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本，与 noj-core 测试写法一致
import { assertEquals } from 'jsr:@std/assert@^1';
import { isAdminUser } from '../utils/isAdminUser.ts';

Deno.test('isAdminUser: 空值返回 false', () => {
  assertEquals(isAdminUser(null), false);
  assertEquals(isAdminUser(undefined), false);
});

Deno.test('isAdminUser: is_admin 字段优先', () => {
  assertEquals(isAdminUser({ is_admin: true }), true);
  assertEquals(isAdminUser({ is_admin: false }), false);
  assertEquals(isAdminUser({ is_admin: false, role: 'admin' }), false);
});

Deno.test('isAdminUser: 无 is_admin 时兼容 role 字段', () => {
  assertEquals(isAdminUser({ role: 'admin' }), true);
  assertEquals(isAdminUser({ role: 'user' }), false);
});
