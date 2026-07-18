/**
 * 题目样例提取工具。
 *
 * 从题目描述（Markdown）中提取样例输入/输出对。
 * 支持格式：
 *
 * ```
 * ## 样例输入 1
 * ```
 * <input content>
 * ```
 *
 * ## 样例输出 1
 * ```
 * <output content>
 * ```
 * ```
 */

/**
 * 从 Markdown 描述中提取所有样例输入/输出对。
 *
 * 按标题匹配 "样例输入" / "样例输出"（支持英文 "Sample Input" / "Sample Output"），
 * 紧随标题后的第一个代码块内容即为对应值。
 */
export function extractSamples(
  description: string,
): { input: string; output: string }[] {
  const samples: { input: string; output: string }[] = [];

  // 匹配样例标题行：## 样例输入 1 / ## Sample Input 1
  const inputRegex = /##\s*(?:样例输入|Sample\s+Input)\s*(\d*)/gi;
  const outputRegex = /##\s*(?:样例输出|Sample\s+Output)\s*(\d*)/gi;

  const inputMatches: { index: number; label: string }[] = [];
  const outputMatches: { index: number; label: string }[] = [];

  let match: RegExpExecArray | null;
  while ((match = inputRegex.exec(description)) !== null) {
    inputMatches.push({ index: match.index, label: match[1] || "" });
  }
  while ((match = outputRegex.exec(description)) !== null) {
    outputMatches.push({ index: match.index, label: match[1] || "" });
  }

  // 按编号配对
  const pairCount = Math.min(inputMatches.length, outputMatches.length);
  for (let i = 0; i < pairCount; i++) {
    const input = extractCodeBlockAfter(description, inputMatches[i].index);
    const output = extractCodeBlockAfter(description, outputMatches[i].index);
    samples.push({
      input: input ?? "",
      output: output ?? "",
    });
  }

  return samples;
}

/**
 * 从 Markdown 文本的指定位置之后，提取第一个围栏代码块（```...```）的内容。
 * 支持语言标识行（如 ```python）和纯 ```。
 */
function extractCodeBlockAfter(
  text: string,
  startIndex: number,
): string | null {
  const after = text.slice(startIndex);
  // 匹配第一个围栏代码块起始标记
  const fenceStartMatch = after.match(/```\w*\n/);
  if (!fenceStartMatch) return null;

  const contentStart = fenceStartMatch.index! + fenceStartMatch[0].length;
  // 在内容之后找闭合标记
  const remaining = after.slice(contentStart);
  const fenceEndMatch = remaining.match(/\n```\s*\n?/);
  if (!fenceEndMatch) return null;

  return remaining.slice(0, fenceEndMatch.index).trimEnd();
}
