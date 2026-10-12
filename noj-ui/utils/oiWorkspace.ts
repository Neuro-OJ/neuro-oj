/** 公开题目样例，与隐藏测试数据独立。 */
export interface ProblemSample {
  id: string;
  input: string;
  output: string;
  explanation?: string;
}

/** 用户用例；缺省预期输出表示只运行，空字符串仍需要比较。 */
export interface OiWorkspaceCase {
  id: string;
  input: string;
  expected_output?: string;
  enabled: boolean;
  origin: 'sample' | 'custom';
}

/** 只提取明确的「样例输入/输出」标题与紧随其后的 fenced 文本，不猜测其他题面。 */
export function extractStatementSamples(
  statement: string,
): { samples: { input: string; output: string }[]; remaining: string } {
  const block =
    /^#{1,6}[ \t]*(样例输入|输入样例|样例输出|输出样例|Sample Input|Sample Output)[ \t]*(\d*)[^\n]*\n[ \t\r\n]*```[^\n]*\n([\s\S]*?)^```[^\n]*(?:\n|$)/gim;
  const found: { kind: 'input' | 'output'; number: string; content: string; start: number; end: number }[] = [];
  for (const match of statement.matchAll(block)) {
    found.push({
      kind: /输入|input/i.test(match[1]!) ? 'input' : 'output',
      number: match[2] || '1',
      content: match[3]!,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  const samples: { input: string; output: string }[] = [];
  const removed: { start: number; end: number }[] = [];
  for (const input of found.filter((item) => item.kind === 'input')) {
    const outputs = found.filter((item) => item.kind === 'output' && item.number === input.number);
    if (
      outputs.length !== 1 || found.filter((item) => item.kind === 'input' && item.number === input.number).length !== 1
    ) continue;
    samples.push({ input: input.content, output: outputs[0]!.content });
    removed.push(input, outputs[0]!);
  }
  let remaining = statement;
  for (const section of removed.sort((a, b) => b.start - a.start)) {
    remaining = remaining.slice(0, section.start) + remaining.slice(section.end);
  }
  return { samples, remaining };
}

/** 默认整数等分规则，与 Hydro 和 Core 的实现保持一致。 */
export function caseMaxScores(subtask: { score: number; scoring?: string; cases: { score?: number }[] }): number[] {
  if (subtask.scoring !== 'sum') return subtask.cases.map((item) => item.score ?? subtask.score);
  const count = subtask.cases.filter((item) => item.score === undefined).length;
  const total = Math.max(0, subtask.score - subtask.cases.reduce((sum, item) => sum + (item.score ?? 0), 0));
  const base = count ? Math.floor(total / count) : 0;
  const remainder = total - base * count;
  let index = 0;
  return subtask.cases.map((item) => item.score ?? base + Math.max(0, Math.min(1, remainder - (count - 1 - index++))));
}
