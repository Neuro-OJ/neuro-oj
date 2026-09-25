/**
 * 公告横幅关闭状态测试。
 *
 * 覆盖：键名语义、解析容错（空/非 JSON/非数组/混合类型）、序列化往返。
 */
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { DISMISS_KEY, parseDismissed, serializeDismissed } from '../utils/announcementDismiss.ts';

Deno.test('announcementDismiss: 存储键绑定公告 id 语义', () => {
  assertEquals(DISMISS_KEY, 'noj:announcement-dismissed');
});

Deno.test('announcementDismiss: 解析容错（空/非 JSON/非数组/混合类型）', () => {
  assertEquals(parseDismissed(null).size, 0);
  assertEquals(parseDismissed('').size, 0);
  assertEquals(parseDismissed('not-json').size, 0);
  assertEquals(parseDismissed('{"a":1}').size, 0);
  const parsed = parseDismissed(JSON.stringify(['a', 1, null, 'b']));
  assertEquals([...parsed].sort(), ['a', 'b']);
});

Deno.test('announcementDismiss: 序列化往返一致', () => {
  const set = new Set(['ann-1', 'ann-2']);
  const round = parseDismissed(serializeDismissed(set));
  assertEquals([...round].sort(), ['ann-1', 'ann-2']);
});

Deno.test('announcementDismiss: 不同 id 相互独立', () => {
  const set = new Set(['ann-1']);
  assertEquals(parseDismissed(serializeDismissed(set)).has('ann-1'), true);
  assertEquals(parseDismissed(serializeDismissed(set)).has('ann-2'), false);
});
