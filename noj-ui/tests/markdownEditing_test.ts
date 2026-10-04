// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { insertBlock, insertText, prefixLines, wrapSelection } from '../utils/markdownEditing.ts';

Deno.test('wrapSelection 包裹选中文本并保持选区在原文本上', () => {
  const r = wrapSelection('hello world', 6, 11, '**', '**');
  assertEquals(r.text, 'hello **world**');
  assertEquals([r.selectionStart, r.selectionEnd], [8, 13]);
});

Deno.test('wrapSelection 空选区插入占位符并选中', () => {
  const r = wrapSelection('ab', 1, 1, '*', '*', '斜体');
  assertEquals(r.text, 'a*斜体*b');
  assertEquals(r.text.slice(r.selectionStart, r.selectionEnd), '斜体');
});

Deno.test('wrapSelection 对已包裹的选区取消包裹', () => {
  const r = wrapSelection('hello **world**', 8, 13, '**', '**');
  assertEquals(r.text, 'hello world');
  assertEquals([r.selectionStart, r.selectionEnd], [6, 11]);
});

Deno.test('prefixLines 为选区覆盖的每行加前缀，再次执行则移除', () => {
  const src = 'a\nb\nc';
  const added = prefixLines(src, 0, 3, '- ');
  assertEquals(added.text, '- a\n- b\nc');
  const removed = prefixLines(added.text, added.selectionStart, added.selectionEnd, '- ');
  assertEquals(removed.text, src);
});

Deno.test('prefixLines 光标在行中时作用于整行', () => {
  assertEquals(prefixLines('foo\nbar', 5, 5, '> ').text, 'foo\n> bar');
});

Deno.test('prefixLines 选区止于换行符后不影响下一行', () => {
  assertEquals(prefixLines('a\nb', 0, 2, '> ').text, '> a\nb');
});

Deno.test('prefixLines 支持按行号生成有序列表前缀', () => {
  assertEquals(prefixLines('x\ny', 0, 3, (i) => `${i + 1}. `).text, '1. x\n2. y');
});

Deno.test('insertBlock 与前后内容各隔一个空行，光标落在指定偏移', () => {
  const r = insertBlock('前文后文', 2, 2, '$$\n\n$$', 3);
  assertEquals(r.text, '前文\n\n$$\n\n$$\n\n后文');
  assertEquals(r.selectionStart, '前文\n\n$$\n'.length);
});

Deno.test('insertBlock 在空文本与已有空行处不重复插入空行', () => {
  assertEquals(insertBlock('', 0, 0, '---').text, '---');
  assertEquals(insertBlock('a\n\n', 3, 3, '---').text, 'a\n\n---');
});

Deno.test('insertText 替换选区并将光标置于插入内容之后', () => {
  const r = insertText('abc', 1, 2, '  ');
  assertEquals(r.text, 'a  c');
  assertEquals([r.selectionStart, r.selectionEnd], [3, 3]);
});
