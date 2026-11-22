/**
 * 文本行级差异（LCS），用于运行历史中"历史版本 vs 当前参数"的对比预览。
 */

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
