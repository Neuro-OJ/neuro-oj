/**
 * Markdown 编辑器文本操作纯函数。
 *
 * `MarkdownEditor` 工具栏与快捷键基于 textarea 选区调用这些函数，
 * 返回新文本与新选区；与 DOM 解耦以便单元测试。
 */

/** 一次编辑的结果：新文本 + 新选区（start/end 为字符偏移）。 */
export interface EditResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * 用前后缀包裹选区（加粗、斜体、行内代码等）。
 *
 * - 选区为空时插入 `placeholder` 并选中它，便于直接输入替换；
 * - 选区已被同一前后缀包裹时取消包裹（切换语义）。
 */
export function wrapSelection(
  text: string,
  start: number,
  end: number,
  prefix: string,
  suffix: string,
  placeholder = '',
): EditResult {
  const selected = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);

  if (selected && before.endsWith(prefix) && after.startsWith(suffix)) {
    return {
      text: before.slice(0, before.length - prefix.length) + selected + after.slice(suffix.length),
      selectionStart: start - prefix.length,
      selectionEnd: end - prefix.length,
    };
  }

  const inner = selected || placeholder;
  return {
    text: before + prefix + inner + suffix + after,
    selectionStart: start + prefix.length,
    selectionEnd: start + prefix.length + inner.length,
  };
}

/**
 * 为选区覆盖的每一行添加行首前缀（标题、引用、列表）。
 *
 * 所有行都已有该前缀时整体移除（切换语义）。`prefix` 可以是函数，
 * 按行序号生成（有序列表 `1. ` / `2. `）。
 */
export function prefixLines(
  text: string,
  start: number,
  end: number,
  prefix: string | ((index: number) => string),
): EditResult {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const nl = text.indexOf('\n', end > start && text[end - 1] === '\n' ? end - 1 : end);
  const lineEnd = nl === -1 ? text.length : nl;
  const lines = text.slice(lineStart, lineEnd).split('\n');
  const prefixOf = (i: number) => typeof prefix === 'function' ? prefix(i) : prefix;

  const allPrefixed = lines.every((line, i) => line.startsWith(prefixOf(i)));
  const next = lines.map((line, i) => allPrefixed ? line.slice(prefixOf(i).length) : prefixOf(i) + line);
  const block = next.join('\n');

  return {
    text: text.slice(0, lineStart) + block + text.slice(lineEnd),
    selectionStart: lineStart,
    selectionEnd: lineStart + block.length,
  };
}

/**
 * 插入块级片段（代码块、公式块、分隔线），保证与前后内容间隔一个空行。
 *
 * `cursorOffset` 为插入后光标相对片段起点的位置；省略时置于片段末尾。
 */
export function insertBlock(
  text: string,
  start: number,
  end: number,
  block: string,
  cursorOffset?: number,
): EditResult {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after === '' || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const cursor = before.length + lead.length + (cursorOffset ?? block.length);
  return {
    text: before + lead + block + trail + after,
    selectionStart: cursor,
    selectionEnd: cursor,
  };
}

/** 在选区处插入纯文本（Tab 缩进等），光标落在插入内容之后。 */
export function insertText(text: string, start: number, end: number, value: string): EditResult {
  const cursor = start + value.length;
  return {
    text: text.slice(0, start) + value + text.slice(end),
    selectionStart: cursor,
    selectionEnd: cursor,
  };
}
