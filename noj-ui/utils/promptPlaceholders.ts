/**
 * 提示词题占位符工具。
 *
 * 约定（见 noj-docs 提示词题文档）：出题人在题面中用行内代码写出占位符，
 * 例如 `` `{text}` ``；评测脚本会把提示词里的 `{text}` 替换为测试输入。
 * 前端据此提示选手哪些占位符已使用、哪些缺失，并支持一键插入。
 */

/** 提示词中的占位符：`{identifier}`。 */
const PROMPT_PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 题面中声明的占位符：只认行内代码 `` `{identifier}` ``，避免误伤 LaTeX 的 `{a}`。 */
const STATEMENT_PLACEHOLDER_RE = /`\{([A-Za-z_][A-Za-z0-9_]*)\}`/g;

function uniqueMatches(text: string, re: RegExp): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) {
    if (m[1]) seen.add(m[1]);
  }
  return [...seen];
}

/** 提取提示词中出现的占位符名（去重，保持首次出现顺序）。 */
export function extractPromptPlaceholders(prompt: string): string[] {
  return uniqueMatches(prompt, PROMPT_PLACEHOLDER_RE);
}

/** 提取题面中以行内代码声明的占位符名（去重，保持首次出现顺序）。 */
export function extractStatementPlaceholders(statement: string): string[] {
  return uniqueMatches(statement, STATEMENT_PLACEHOLDER_RE);
}

/** 占位符状态：题面要求且已使用 / 题面要求但缺失 / 提示词自定义（题面未声明）。 */
export type PlaceholderState = 'used' | 'missing' | 'extra';

export interface PlaceholderItem {
  name: string;
  state: PlaceholderState;
}

/**
 * 合并题面声明与提示词实际使用的占位符，题面声明的排在前面。
 */
export function summarizePlaceholders(
  statement: string,
  prompt: string,
): PlaceholderItem[] {
  const expected = extractStatementPlaceholders(statement);
  const used = new Set(extractPromptPlaceholders(prompt));
  const items: PlaceholderItem[] = expected.map((name) => ({
    name,
    state: used.has(name) ? 'used' : 'missing',
  }));
  for (const name of used) {
    if (!expected.includes(name)) items.push({ name, state: 'extra' });
  }
  return items;
}

/**
 * 在选区处插入文本，返回新文本与插入后的光标位置。
 * 选区越界时按文本长度裁剪。
 */
export function insertAtSelection(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; cursor: number } {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return {
    text: text.slice(0, s) + insert + text.slice(e),
    cursor: s + insert.length,
  };
}

/** 行级差异的一行：same=两边相同，add=仅新版本有，del=仅旧版本有。 */
export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** 超过该乘积规模不做 LCS（避免 O(n·m) 卡顿），直接整体视为替换。 */
const MAX_DIFF_CELLS = 2_000_000;

/**
 * 计算 `from` → `to` 的行级差异（LCS）。
 * 用于运行历史中"历史版本 vs 当前编辑内容"的对比预览。
 */
export function diffLines(from: string, to: string): DiffLine[] {
  const a = from.split('\n');
  const b = to.split('\n');
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'del', text })),
      ...b.map((text): DiffLine => ({ kind: 'add', text })),
    ];
  }
  // lcs[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i++]! });
    } else {
      out.push({ kind: 'add', text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'add', text: b[j++]! });
  return out;
}
