import { assertEquals } from 'jsr:@std/assert@^1';
import { caseMaxScores, extractStatementSamples } from '../utils/oiWorkspace.ts';

Deno.test('OI 工作区整数等分与显式零分保留', () => {
  assertEquals(caseMaxScores({ score: 100, scoring: 'sum', cases: [{}, {}, {}] }), [33, 33, 34]);
  assertEquals(caseMaxScores({ score: 100, scoring: 'sum', cases: [{ score: 0 }, {}, {}] }), [0, 50, 50]);
});
Deno.test('样例提取只转换明确配对片段，保留其他题面', () => {
  const statement = '# A+B\n正文\n## 样例输入 1\n```text\n1 2\n```\n## 样例输出 1\n```\n3\n```\n## 说明\n保留';
  assertEquals(extractStatementSamples(statement), {
    samples: [{ input: '1 2\n', output: '3\n' }],
    remaining: '# A+B\n正文\n## 说明\n保留',
  });
  assertEquals(extractStatementSamples('## 输入\n```\n1 2\n```\n## 输出\n```\n3\n```').samples, []);
  assertEquals(extractStatementSamples('## 样例输入 1\n```\n1\n```').samples, []);
});
