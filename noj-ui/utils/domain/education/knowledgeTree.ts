/**
 * 知识图谱「技能树视图」纯拓扑布局与状态派生（无 Nuxt/DOM 依赖，可独立单测）。
 */
import type { KnowledgeGraph, KnowledgeNode, MasteryItem, MasteryState } from './knowledge';

/** 技能树节点在学习视图中的展示状态。 */
export type SkillTreeNodeStatus =
  | 'mastered'
  | 'placed'
  | 'learning'
  | 'recommended'
  | 'available'
  | 'locked';

export interface SkillTreeLayoutOptions {
  areaId: string;
  syllabus?: string;
  onlyWithProblems?: boolean;
  masteryByNode?: ReadonlyMap<string, Pick<MasteryItem, 'state' | 'solved_count' | 'problem_count'>>;
  placedNodeIds?: ReadonlySet<string>;
  recommendedIds?: ReadonlySet<string>;
}

export interface SkillTreeNodeLayout {
  node: KnowledgeNode;
  column: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  status: SkillTreeNodeStatus;
  solvedCount: number;
  problemCount: number;
  hasDoc: boolean;
  requiresInArea: string[];
  externalRequires: Array<{ id: string; name: string; area: string; completed: boolean }>;
  dependentsInArea: string[];
}

export interface SkillTreeEdgeLayout {
  id: string;
  fromId: string;
  toId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  path: string;
}

export interface SkillTreeLayoutResult {
  areaId: string;
  nodes: SkillTreeNodeLayout[];
  edges: SkillTreeEdgeLayout[];
  columns: number;
  width: number;
  height: number;
}

export interface SkillTreeAreaSummary {
  id: string;
  name: string;
  sort: number;
  totalNodes: number;
  masteredCount: number;
  learningCount: number;
  placedCount: number;
  availableProblems: number;
  docCount: number;
}

export const SKILL_TREE_NODE_WIDTH = 224;
export const SKILL_TREE_NODE_HEIGHT = 96;
export const SKILL_TREE_COL_GAP = 64;
export const SKILL_TREE_ROW_GAP = 16;
export const SKILL_TREE_PADDING = 20;

function isCompleted(
  nodeId: string,
  masteryByNode: ReadonlyMap<string, Pick<MasteryItem, 'state'>>,
  placedNodeIds: ReadonlySet<string>,
): boolean {
  return masteryByNode.get(nodeId)?.state === 'mastered' || placedNodeIds.has(nodeId);
}

/**
 * 汇总各领域技能树进度与题目/讲解覆盖数。
 */
export function summarizeSkillTreeAreas(
  graph: KnowledgeGraph | null,
  masteryByNode: ReadonlyMap<string, Pick<MasteryItem, 'state' | 'problem_count'>> = new Map(),
  placedNodeIds: ReadonlySet<string> = new Set(),
  syllabus = 'all',
): SkillTreeAreaSummary[] {
  if (!graph) return [];
  const normSyllabus = syllabus.trim().toLowerCase();
  const byArea = new Map<string, SkillTreeAreaSummary>();
  for (const area of graph.areas) {
    byArea.set(area.id, {
      id: area.id,
      name: area.name,
      sort: area.sort,
      totalNodes: 0,
      masteredCount: 0,
      learningCount: 0,
      placedCount: 0,
      availableProblems: 0,
      docCount: 0,
    });
  }
  for (const node of graph.nodes) {
    if (
      normSyllabus !== 'all' &&
      (!node.syllabus || !node.syllabus.some((tag) => tag.toLowerCase() === normSyllabus))
    ) {
      continue;
    }
    const summary = byArea.get(node.area);
    if (!summary) continue;
    summary.totalNodes++;
    const mastery = masteryByNode.get(node.id);
    if (mastery?.state === 'mastered') summary.masteredCount++;
    else if (placedNodeIds.has(node.id)) summary.placedCount++;
    else if (mastery?.state === 'learning') summary.learningCount++;
    summary.availableProblems += node.problem_count ?? mastery?.problem_count ?? 0;
    if (node.doc) summary.docCount++;
  }
  return [...byArea.values()]
    .filter((item) => item.totalNodes > 0)
    .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
}

/**
 * 构建单个领域内（含前置跨领域外部标签）的轻量 DAG 拓扑布局。
 */
export function buildSkillTreeLayout(
  graph: KnowledgeGraph | null,
  options: SkillTreeLayoutOptions,
): SkillTreeLayoutResult {
  if (!graph) {
    return { areaId: options.areaId, nodes: [], edges: [], columns: 0, width: 0, height: 0 };
  }
  const masteryByNode = options.masteryByNode ?? new Map();
  const placedNodeIds = options.placedNodeIds ?? new Set<string>();
  const recommendedIds = options.recommendedIds ?? new Set<string>();
  const normSyllabus = (options.syllabus ?? 'all').trim().toLowerCase();
  const nodeLookup = new Map(graph.nodes.map((node) => [node.id, node]));

  const areaNodes = graph.nodes.filter((node) => {
    if (node.area !== options.areaId) return false;
    if (
      normSyllabus !== 'all' &&
      (!node.syllabus || !node.syllabus.some((tag) => tag.toLowerCase() === normSyllabus))
    ) {
      return false;
    }
    if (options.onlyWithProblems) {
      const count = node.problem_count ?? masteryByNode.get(node.id)?.problem_count ?? 0;
      if (count <= 0) return false;
    }
    return true;
  });

  if (areaNodes.length === 0) {
    return { areaId: options.areaId, nodes: [], edges: [], columns: 0, width: 0, height: 0 };
  }

  const areaSet = new Set(areaNodes.map((n) => n.id));
  const depthMemo = new Map<string, number>();
  const visiting = new Set<string>();

  function depthOf(id: string): number {
    const cached = depthMemo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const node = nodeLookup.get(id);
    let maxParent = -1;
    for (const req of node?.requires ?? []) {
      if (!areaSet.has(req)) continue;
      maxParent = Math.max(maxParent, depthOf(req));
    }
    visiting.delete(id);
    const depth = maxParent + 1;
    depthMemo.set(id, depth);
    return depth;
  }

  for (const node of areaNodes) depthOf(node.id);

  // 逐列分组，同列内按“父节点平均行序 → 图谱原始顺序”排布，降低连线交叉。
  const columnsMap = new Map<number, KnowledgeNode[]>();
  const originalOrder = new Map(areaNodes.map((n, idx) => [n.id, idx]));
  for (const node of areaNodes) {
    const col = depthMemo.get(node.id) ?? 0;
    const list = columnsMap.get(col) ?? [];
    list.push(node);
    columnsMap.set(col, list);
  }
  const maxCol = Math.max(...columnsMap.keys());
  const rowIndexById = new Map<string, number>();
  const dependentsMap = new Map<string, string[]>();
  for (const node of areaNodes) {
    for (const req of node.requires) {
      if (!areaSet.has(req)) continue;
      const list = dependentsMap.get(req) ?? [];
      list.push(node.id);
      dependentsMap.set(req, list);
    }
  }

  for (let col = 0; col <= maxCol; col++) {
    const list = columnsMap.get(col) ?? [];
    if (col > 0) {
      list.sort((a, b) => {
        const aReqs = a.requires.filter((id) => areaSet.has(id) && rowIndexById.has(id));
        const bReqs = b.requires.filter((id) => areaSet.has(id) && rowIndexById.has(id));
        const aAvg = aReqs.length > 0
          ? aReqs.reduce((sum, id) => sum + (rowIndexById.get(id) ?? 0), 0) / aReqs.length
          : Number.MAX_SAFE_INTEGER;
        const bAvg = bReqs.length > 0
          ? bReqs.reduce((sum, id) => sum + (rowIndexById.get(id) ?? 0), 0) / bReqs.length
          : Number.MAX_SAFE_INTEGER;
        if (aAvg !== bAvg) return aAvg - bAvg;
        return (originalOrder.get(a.id) ?? 0) - (originalOrder.get(b.id) ?? 0);
      });
    }
    list.forEach((node, rowIdx) => rowIndexById.set(node.id, rowIdx));
  }

  const maxRows = Math.max(...[...columnsMap.values()].map((list) => list.length));
  const layoutById = new Map<string, SkillTreeNodeLayout>();
  const layouts: SkillTreeNodeLayout[] = [];

  for (let col = 0; col <= maxCol; col++) {
    const list = columnsMap.get(col) ?? [];
    for (let row = 0; row < list.length; row++) {
      const node = list[row]!;
      const x = SKILL_TREE_PADDING + col * (SKILL_TREE_NODE_WIDTH + SKILL_TREE_COL_GAP);
      const y = SKILL_TREE_PADDING + row * (SKILL_TREE_NODE_HEIGHT + SKILL_TREE_ROW_GAP);
      const mastery = masteryByNode.get(node.id);
      const state: MasteryState = mastery?.state ?? 'none';
      const allReqsDone = node.requires.every((reqId) => isCompleted(reqId, masteryByNode, placedNodeIds));
      let status: SkillTreeNodeStatus;
      if (state === 'mastered') status = 'mastered';
      else if (placedNodeIds.has(node.id)) status = 'placed';
      else if (state === 'learning') status = 'learning';
      else if (recommendedIds.has(node.id)) status = 'recommended';
      else if (allReqsDone) status = 'available';
      else status = 'locked';

      const requiresInArea = node.requires.filter((id) => areaSet.has(id));
      const externalRequires = node.requires
        .filter((id) => !areaSet.has(id))
        .map((id) => {
          const target = nodeLookup.get(id);
          return {
            id,
            name: target?.name ?? id,
            area: target?.area ?? id.split('.')[0] ?? '',
            completed: isCompleted(id, masteryByNode, placedNodeIds),
          };
        });

      const item: SkillTreeNodeLayout = {
        node,
        column: col,
        row,
        x,
        y,
        width: SKILL_TREE_NODE_WIDTH,
        height: SKILL_TREE_NODE_HEIGHT,
        status,
        solvedCount: mastery?.solved_count ?? 0,
        problemCount: node.problem_count ?? mastery?.problem_count ?? 0,
        hasDoc: Boolean(node.doc),
        requiresInArea,
        externalRequires,
        dependentsInArea: dependentsMap.get(node.id) ?? [],
      };
      layouts.push(item);
      layoutById.set(node.id, item);
    }
  }

  const edges: SkillTreeEdgeLayout[] = [];
  for (const item of layouts) {
    for (const reqId of item.requiresInArea) {
      const from = layoutById.get(reqId);
      if (!from) continue;
      const x1 = from.x + from.width;
      const y1 = from.y + from.height / 2;
      const x2 = item.x;
      const y2 = item.y + item.height / 2;
      const dx = Math.max(24, (x2 - x1) * 0.5);
      const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      edges.push({
        id: `${from.node.id}->${item.node.id}`,
        fromId: from.node.id,
        toId: item.node.id,
        x1,
        y1,
        x2,
        y2,
        path,
      });
    }
  }

  const columns = maxCol + 1;
  const width = SKILL_TREE_PADDING * 2 + columns * SKILL_TREE_NODE_WIDTH +
    Math.max(0, columns - 1) * SKILL_TREE_COL_GAP;
  const height = SKILL_TREE_PADDING * 2 + maxRows * SKILL_TREE_NODE_HEIGHT +
    Math.max(0, maxRows - 1) * SKILL_TREE_ROW_GAP;

  return { areaId: options.areaId, nodes: layouts, edges, columns, width, height };
}
