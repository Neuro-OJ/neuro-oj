// deno-lint-ignore no-import-prefix -- 沿用仓库固定断言库
import { assertEquals } from 'jsr:@std/assert@^1';
import { readUnreadCount } from '../utils/unread-count.ts';
Deno.test('未读接口按既有契约读取，拒绝错误结构而非渲染时抛错', () => {
  assertEquals(readUnreadCount({ unread_count: 4 }, 'messages'), 4);
  assertEquals(readUnreadCount({ data: { count: 3 } }, 'domain'), 3);
  assertEquals(readUnreadCount({ data: { unread_count: 2 } }, 'account'), 2);
  for (const value of [undefined, null, {}, { data: null }, { unread_count: -1 }, { unread_count: '4' }]) {
    assertEquals(readUnreadCount(value, 'messages'), null);
  }
  assertEquals(readUnreadCount({ data: { unread_count: 4 } }, 'messages'), null);
  assertEquals(readUnreadCount({ data: { count: 0 } }, 'domain'), 0);
});
