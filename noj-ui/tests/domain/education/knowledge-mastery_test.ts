/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assert, assertEquals } from 'jsr:@std/assert@^1';
import {
  type ClassroomMasteryArea,
  coverageNodeHasProblem,
  filterMasteryAreas,
  knowledgeNodePath,
  masteryCellState,
  masteryCellTitle,
  masteryCountsText,
  masteryPercent,
  masteryStateColor,
  masteryStateLabel,
  masteryStudentLabel,
  nodeHasLearners,
  parsePickCount,
  recommendationReasonText,
} from '../../../utils/domain/education/knowledge.ts';

Deno.test('推荐理由：四种已知 code 拼中文，未知 code 回退通用文案', () => {
  assertEquals(
    recommendationReasonText({ code: 'continue_learning', params: { remaining: 2 } }),
    '已在学习中，再完成 2 道达标题即可掌握',
  );
  assertEquals(
    recommendationReasonText({
      code: 'prerequisites_mastered',
      params: { prerequisites: [{ id: 'ds.stack', name: '栈' }, { id: 'ds.queue', name: '队列' }] },
    }),
    '前置知识点 栈、队列 已掌握，可以开始',
  );
  assertEquals(recommendationReasonText({ code: 'entry_point', params: {} }), '入门知识点，适合作为起点');
  assertEquals(
    recommendationReasonText({
      code: 'review_prerequisite',
      params: { node_name: '树', prerequisite_name: '链表' },
    }),
    '你在 树 上多次未达标，建议先巩固 链表',
  );
  assertEquals(recommendationReasonText({ code: 'unknown', params: {} }), '根据你的学习进度推荐');
  assertEquals(recommendationReasonText(null), '根据你的学习进度推荐');
});

Deno.test('掌握状态：文案与徽标配色（已掌握绿/学习中主色/未开始中性灰）', () => {
  assertEquals(masteryStateLabel('mastered'), '已掌握');
  assertEquals(masteryStateLabel('learning'), '学习中');
  assertEquals(masteryStateLabel('none'), '未开始');
  assertEquals(masteryStateColor('mastered'), 'success');
  assertEquals(masteryStateColor('learning'), 'primary');
  assertEquals(masteryStateColor('none'), 'neutral');
  assertEquals(masteryPercent(1, 4), 25);
  assertEquals(masteryPercent(0, 0), 0);
});

Deno.test('覆盖度：题量不足或难度断层视为有问题的节点', () => {
  const base = {
    node_id: 'ds.array',
    name: '数组',
    area: 'ds',
    difficulty_distribution: { easy: 0, medium: 0, hard: 0 },
    problem_count: 0,
    insufficient_problems: false,
    difficulty_gap: false,
  };
  assert(!coverageNodeHasProblem(base));
  assert(coverageNodeHasProblem({ ...base, insufficient_problems: true }));
  assert(coverageNodeHasProblem({ ...base, difficulty_gap: true }));
});

Deno.test('P4 掌握矩阵：稀疏 cells 缺省为未开始，状态文案与筛选', () => {
  const areas: ClassroomMasteryArea[] = [{
    id: 'ml',
    name: '机器学习基础',
    nodes: [
      { id: 'ml.lr', name: '线性回归', problem_count: 4, counts: { mastered: 1, learning: 1, none: 1 } },
      { id: 'ml.svm', name: '支持向量机', problem_count: 2, counts: { mastered: 0, learning: 0, none: 3 } },
    ],
  }];
  const view = { classroom_id: 'c', students: [], areas, cells: { u1: { 'ml.lr': 'mastered' as const } } };
  assertEquals(masteryCellState(view, 'u1', 'ml.lr'), 'mastered');
  assertEquals(masteryCellState(view, 'u1', 'ml.svm'), 'none');
  assertEquals(masteryCellTitle('学生甲', '线性回归', 'learning'), '学生甲 · 线性回归：学习中');
  assertEquals(masteryCountsText({ mastered: 3, learning: 2, none: 5 }), '已掌握 3 / 学习中 2');
  assertEquals(nodeHasLearners(areas[0]!.nodes[0]!), true);
  assertEquals(filterMasteryAreas(areas, true)[0]!.nodes.map((node) => node.id), ['ml.lr']);
  assertEquals(filterMasteryAreas(areas, false)[0]!.nodes.length, 2);
  assertEquals(masteryStudentLabel({ username: 'stu01', display_name: '小明' }), '小明');
  assertEquals(masteryStudentLabel({ username: 'stu01', display_name: null }), 'stu01');
  assertEquals(knowledgeNodePath('school', 'ml.lr'), '/d/school/knowledge/ml.lr');
});

Deno.test('P4 挑题数量：默认 5，1–20 整数，越界报错', () => {
  assertEquals(parsePickCount(5).value, 5);
  assertEquals(parsePickCount('20').value, 20);
  assertEquals(parsePickCount(0).error !== undefined, true);
  assertEquals(parsePickCount(21).error !== undefined, true);
  assertEquals(parsePickCount('2.5').error !== undefined, true);
});
