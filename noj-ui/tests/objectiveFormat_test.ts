/** utils/objectiveFormat.ts 单元测试。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { formatObjectiveAnswer } from '../utils/objectiveFormat.ts';

Deno.test('formatObjectiveAnswer: 无题目信息时直接拼接', () => {
  assertEquals(formatObjectiveAnswer(undefined, ['A', 'B']), 'A, B');
});

Deno.test('formatObjectiveAnswer: 判断题显示正确/错误', () => {
  const q = { type: 'judge' as const, options: [] };
  assertEquals(formatObjectiveAnswer(q, [true]), '正确');
  assertEquals(formatObjectiveAnswer(q, [false]), '错误');
});

Deno.test('formatObjectiveAnswer: 选择题显示选项文本', () => {
  const q = {
    type: 'single' as const,
    options: [
      { key: 'A', text: '选项一' },
      { key: 'B', text: '选项二' },
    ],
  };
  assertEquals(formatObjectiveAnswer(q, ['B']), 'B. 选项二');
});

Deno.test('formatObjectiveAnswer: 多选使用分隔符', () => {
  const q = {
    type: 'multiple' as const,
    options: [
      { key: 'A', text: 'Alpha' },
      { key: 'C', text: 'Charlie' },
    ],
  };
  assertEquals(formatObjectiveAnswer(q, ['A', 'C']), 'A. Alpha；C. Charlie');
});

Deno.test('formatObjectiveAnswer: 空作答显示未作答', () => {
  const q = {
    type: 'single' as const,
    options: [{ key: 'A', text: '选项' }],
  };
  assertEquals(formatObjectiveAnswer(q, []), '未作答');
});
