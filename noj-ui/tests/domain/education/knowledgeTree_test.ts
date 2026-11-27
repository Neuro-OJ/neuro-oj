/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assert, assertEquals } from 'jsr:@std/assert@^1';
import type { KnowledgeGraph, MasteryItem } from '../../../utils/domain/education/knowledge.ts';
import { buildSkillTreeLayout, summarizeSkillTreeAreas } from '../../../utils/domain/education/knowledgeTree.ts';

const sampleGraph: KnowledgeGraph = {
  pack: { id: 'official', version: '2026.11.0-draft' },
  areas: [
    { id: 'prog', name: '编程与工具', sort: 0 },
    { id: 'ml', name: '经典机器学习', sort: 1 },
  ],
  nodes: [
    {
      id: 'prog.python',
      area: 'prog',
      name: 'Python 基础',
      summary: '语法与数据结构',
      syllabus: ['noai', 'lmcc'],
      doc: 'docs/prog.python.md',
      requires: [],
      problem_count: 4,
    },
    {
      id: 'ml.linear',
      area: 'ml',
      name: '线性回归',
      summary: '最小二乘与梯度下降',
      syllabus: ['ioai', 'noai'],
      doc: 'docs/ml.linear-regression.md',
      requires: ['prog.python'],
      problem_count: 3,
    },
    {
      id: 'ml.logistic',
      area: 'ml',
      name: '逻辑回归',
      summary: '交叉熵分类',
      syllabus: ['ioai', 'noai'],
      doc: null,
      requires: ['ml.linear'],
      problem_count: 2,
    },
    {
      id: 'ml.ensemble',
      area: 'ml',
      name: '集成学习',
      summary: 'Bagging 与 Boosting',
      syllabus: ['ioai'],
      doc: null,
      requires: ['ml.logistic'],
      problem_count: 0,
    },
  ],
};

function masteryMap(items: Array<Pick<MasteryItem, 'node_id' | 'state' | 'solved_count' | 'problem_count'>>) {
  return new Map(items.map((item) => [item.node_id, item]));
}

Deno.test('knowledgeTree: 拓扑深度分层、跨领域前置与状态派生', () => {
  const mastery = masteryMap([
    { node_id: 'prog.python', state: 'mastered', solved_count: 3, problem_count: 4 },
    { node_id: 'ml.linear', state: 'learning', solved_count: 1, problem_count: 3 },
  ]);
  const layout = buildSkillTreeLayout(sampleGraph, {
    areaId: 'ml',
    masteryByNode: mastery,
    recommendedIds: new Set(['ml.linear']),
  });

  assertEquals(layout.columns, 3);
  assertEquals(layout.nodes.length, 3);
  assertEquals(layout.edges.length, 2);

  const linear = layout.nodes.find((n) => n.node.id === 'ml.linear')!;
  const logistic = layout.nodes.find((n) => n.node.id === 'ml.logistic')!;
  const ensemble = layout.nodes.find((n) => n.node.id === 'ml.ensemble')!;

  assertEquals(linear.column, 0);
  assertEquals(logistic.column, 1);
  assertEquals(ensemble.column, 2);

  assertEquals(linear.status, 'learning');
  assertEquals(linear.hasDoc, true);
  assertEquals(linear.externalRequires, [
    { id: 'prog.python', name: 'Python 基础', area: 'prog', completed: true },
  ]);
  // ml.linear 处于 learning 而未 mastered，因此 ml.logistic 仍为 locked。
  assertEquals(logistic.status, 'locked');
  assert(layout.edges.some((e) => e.fromId === 'ml.linear' && e.toId === 'ml.logistic' && e.path.startsWith('M ')));
});

Deno.test('knowledgeTree: 摸底放置与推荐标记可解锁后续节点', () => {
  const layout = buildSkillTreeLayout(sampleGraph, {
    areaId: 'ml',
    placedNodeIds: new Set(['ml.linear']),
    recommendedIds: new Set(['ml.logistic']),
  });

  const linear = layout.nodes.find((n) => n.node.id === 'ml.linear')!;
  const logistic = layout.nodes.find((n) => n.node.id === 'ml.logistic')!;
  const ensemble = layout.nodes.find((n) => n.node.id === 'ml.ensemble')!;

  assertEquals(linear.status, 'placed');
  assertEquals(logistic.status, 'recommended');
  assertEquals(ensemble.status, 'locked');
});

Deno.test('knowledgeTree: 支持考纲筛选与仅看有题节点', () => {
  const noaiOnly = buildSkillTreeLayout(sampleGraph, {
    areaId: 'ml',
    syllabus: 'noai',
    onlyWithProblems: true,
  });
  assertEquals(noaiOnly.nodes.map((n) => n.node.id), ['ml.linear', 'ml.logistic']);

  const summaries = summarizeSkillTreeAreas(
    sampleGraph,
    masteryMap([{ node_id: 'prog.python', state: 'mastered', solved_count: 3, problem_count: 4 }]),
    new Set(['ml.linear']),
  );
  assertEquals(summaries.length, 2);
  assertEquals(summaries[0]!.masteredCount, 1);
  assertEquals(summaries[0]!.docCount, 1);
  assertEquals(summaries[1]!.placedCount, 1);
  assertEquals(summaries[1]!.availableProblems, 5);
});
