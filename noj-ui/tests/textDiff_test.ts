/**
 * utils/textDiff.ts 单元测试。
 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本，与 noj-core 测试写法一致
import { assertEquals } from 'jsr:@std/assert@^1';
import { diffLines } from '../utils/textDiff.ts';

Deno.test('diffLines: 标出新增、删除与相同行', () => {
  assertEquals(diffLines('a\nb\nc', 'a\nx\nc\nd'), [
    { kind: 'same', text: 'a' },
    { kind: 'del', text: 'b' },
    { kind: 'add', text: 'x' },
    { kind: 'same', text: 'c' },
    { kind: 'add', text: 'd' },
  ]);
});

Deno.test('diffLines: 内容相同时全部为 same', () => {
  assertEquals(diffLines('a\nb', 'a\nb').every((l) => l.kind === 'same'), true);
});
