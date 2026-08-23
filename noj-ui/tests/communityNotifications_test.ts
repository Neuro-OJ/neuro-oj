/** utils/communityNotifications.ts 单元测试。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  COMMUNITY_UNREAD_COUNT_REQUEST_OPTIONS,
  shouldLoadCommunityUnreadCount,
} from '../utils/communityNotifications.ts';

Deno.test('communityNotifications: 匿名或关闭社区时不加载未读数', () => {
  assertEquals(shouldLoadCommunityUnreadCount(null, true), false);
  assertEquals(shouldLoadCommunityUnreadCount(undefined, true), false);
  assertEquals(shouldLoadCommunityUnreadCount({ id: 'user-1' }, false), false);
  assertEquals(shouldLoadCommunityUnreadCount({ id: 'user-1' }, undefined), false);
});

Deno.test('communityNotifications: 登录且社区开启时加载未读数', () => {
  assertEquals(shouldLoadCommunityUnreadCount({ id: 'user-1' }, true), true);
});

Deno.test('communityNotifications: 未读数请求不因 401 跳转登录页', () => {
  assertEquals(COMMUNITY_UNREAD_COUNT_REQUEST_OPTIONS, {
    silent: true,
    redirectOnUnauthorized: false,
  });
});
