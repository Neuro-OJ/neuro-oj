/**
 * utils/uiFrame.ts 单元测试。
 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本，与 noj-core 测试写法一致
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1';
import { buildUiFrameDoc, parseValues, sameValues, stableStringify, UI_FRAME_CSP } from '../utils/uiFrame.ts';

Deno.test('buildUiFrameDoc: CSP 与 SDK 在题包界面之前', () => {
  const doc = buildUiFrameDoc('<h1 id="x">hello</h1>');
  assertStringIncludes(doc, `content="${UI_FRAME_CSP}"`);
  assertEquals(doc.indexOf('Content-Security-Policy') < doc.indexOf('window.NOJ'), true);
  assertEquals(doc.indexOf('window.NOJ') < doc.indexOf('<h1 id="x">'), true);
});

Deno.test('UI_FRAME_CSP: 默认禁止一切网络与子框架', () => {
  assertStringIncludes(UI_FRAME_CSP, "default-src 'none'");
  assertEquals(UI_FRAME_CSP.includes('connect-src'), false);
  assertEquals(/https?:/.test(UI_FRAME_CSP), false);
});

Deno.test('stableStringify: 顶层键排序，保证 diff 稳定', () => {
  assertEquals(stableStringify({ b: 1, a: 2 }), '{\n  "a": 2,\n  "b": 1\n}');
});

Deno.test('parseValues: 非法或非对象文本视为空参数', () => {
  assertEquals(parseValues(''), {});
  assertEquals(parseValues('oops'), {});
  assertEquals(parseValues('[1]'), {});
  assertEquals(parseValues('{"a":1}'), { a: 1 });
});

Deno.test('sameValues: 键序无关', () => {
  assertEquals(sameValues({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assertEquals(sameValues({ a: 1 }, { a: 2 }), false);
});
