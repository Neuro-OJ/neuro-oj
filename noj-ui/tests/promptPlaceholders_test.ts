/**
 * utils/promptPlaceholders.ts 单元测试。
 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本，与 noj-core 测试写法一致
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  diffLines,
  extractPromptPlaceholders,
  extractStatementPlaceholders,
  insertAtSelection,
  summarizePlaceholders,
} from '../utils/promptPlaceholders.ts';

Deno.test('extractPromptPlaceholders: 去重并保持首次出现顺序', () => {
  assertEquals(
    extractPromptPlaceholders('{text} 与 {label}，再次 {text}；{1bad} {} 不算'),
    ['text', 'label'],
  );
});

Deno.test('extractStatementPlaceholders: 只认行内代码，忽略 LaTeX 花括号', () => {
  const statement = '用 `{text}` 表示评论，公式 $\\frac{a}{b}$ 中的 {a} 不算';
  assertEquals(extractStatementPlaceholders(statement), ['text']);
});

Deno.test('summarizePlaceholders: 区分已使用 / 缺失 / 自定义', () => {
  const statement = '占位符：`{text}`、`{lang}`';
  assertEquals(summarizePlaceholders(statement, '翻译 {text}，风格 {style}'), [
    { name: 'text', state: 'used' },
    { name: 'lang', state: 'missing' },
    { name: 'style', state: 'extra' },
  ]);
});

Deno.test('insertAtSelection: 替换选区并返回插入后的光标', () => {
  assertEquals(insertAtSelection('abcdef', 2, 4, '{x}'), { text: 'ab{x}ef', cursor: 5 });
});

Deno.test('insertAtSelection: 越界选区按文本长度裁剪', () => {
  assertEquals(insertAtSelection('abc', 10, 20, '{x}'), { text: 'abc{x}', cursor: 6 });
});

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
