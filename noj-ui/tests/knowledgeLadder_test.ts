/** 知识图谱 P2 前端纯工具单测：阶梯/难度/及格线解析。 */
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  difficultyTierColor,
  difficultyTierLabel,
  type KnowledgeLadder,
  ladderEntryItem,
  ladderItemPath,
  parsePassRatioOverride,
} from '../utils/knowledge.ts';

const item = (number: number | null, passed: boolean | null = false) => ({
  problem_id: `p${number}`,
  number,
  title: `题${number}`,
  domain: 'school',
  difficulty: number ?? 0,
  tier: 'easy' as const,
  sample_size: 0,
  passed,
});

Deno.test('难度档位文案与颜色', () => {
  assertEquals(difficultyTierLabel('easy'), '简单');
  assertEquals(difficultyTierLabel('medium'), '中等');
  assertEquals(difficultyTierLabel('hard'), '困难');
  assertEquals(difficultyTierColor('easy'), 'success');
  assertEquals(difficultyTierColor('medium'), 'warning');
  assertEquals(difficultyTierColor('hard'), 'error');
});

Deno.test('首题目标：优先 next，其次第一题，空阶梯为 null', () => {
  const first = item(1001);
  const next = item(1002);
  assertEquals(ladderEntryItem({ node_id: 'n', domain: 'school', items: [first, next], next }), next);
  assertEquals(
    ladderEntryItem({ node_id: 'n', domain: 'school', items: [first], next: null } as KnowledgeLadder),
    first,
  );
  assertEquals(ladderEntryItem({ node_id: 'n', domain: 'school', items: [], next: null }), null);
  assertEquals(ladderEntryItem(null), null);
});

Deno.test('阶梯项路径：有题号才可链接，跨域使用各自域 slug', () => {
  assertEquals(ladderItemPath(item(1001)), '/d/school/problems/1001');
  assertEquals(ladderItemPath({ ...item(7), domain: 'other' }), '/d/other/problems/7');
  assertEquals(ladderItemPath(item(null)), null);
});

Deno.test('及格线解析：空 → null，0–100 整数通过，越界/非整数报错', () => {
  assertEquals(parsePassRatioOverride(''), { value: null });
  assertEquals(parsePassRatioOverride('  '), { value: null });
  assertEquals(parsePassRatioOverride('0'), { value: 0 });
  assertEquals(parsePassRatioOverride('75'), { value: 75 });
  assertEquals(parsePassRatioOverride('100'), { value: 100 });
  assertEquals(parsePassRatioOverride('101').error !== undefined, true);
  assertEquals(parsePassRatioOverride('7.5').error !== undefined, true);
  assertEquals(parsePassRatioOverride('abc').error !== undefined, true);
  assertEquals(parsePassRatioOverride('-5').error !== undefined, true);
});
