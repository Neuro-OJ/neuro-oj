/**
 * 知识图谱「技能树视图」纯拓扑布局与状态派生（无 Nuxt/DOM 依赖，可独立单测）。
 */
import {
  displayAbilityScore,
  type KnowledgeGraph,
  type KnowledgeNode,
  type MasteryItem,
  type MasteryState,
} from './knowledge.ts';

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
  masteryByNode?: ReadonlyMap<
    string,
    Pick<
      MasteryItem,
      | 'state'
      | 'solved_count'
      | 'problem_count'
      | 'ability_score'
      | 'effective_ability'
      | 'needs_review'
    >
  >;
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
  abilityScore: number | null;
  needsReview: boolean;
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
  reviewCount: number;
  avgAbility: number | null;
  availableProblems: number;
  docCount: number;
}

export interface GlobalSkillTreeAreaCluster {
  areaId: string;
  name: string;
  stage: number;
  x: number;
  y: number;
  width: number;
  height: number;
  nodeCount: number;
  masteredCount: number;
  placedCount: number;
  learningCount: number;
  reviewCount: number;
}

export interface GlobalSkillTreeEdgeLayout extends SkillTreeEdgeLayout {
  crossArea: boolean;
}

export interface GlobalSkillTreeLayoutOptions {
  syllabus?: string;
  onlyWithProblems?: boolean;
  masteryByNode?: ReadonlyMap<
    string,
    Pick<
      MasteryItem,
      | 'state'
      | 'solved_count'
      | 'problem_count'
      | 'ability_score'
      | 'effective_ability'
      | 'needs_review'
    >
  >;
  placedNodeIds?: ReadonlySet<string>;
  recommendedIds?: ReadonlySet<string>;
}

export interface GlobalSkillTreeLayoutResult {
  clusters: GlobalSkillTreeAreaCluster[];
  nodes: SkillTreeNodeLayout[];
  edges: GlobalSkillTreeEdgeLayout[];
  stageCount: number;
  width: number;
  height: number;
}

export const SKILL_TREE_NODE_WIDTH = 224;
export const SKILL_TREE_NODE_HEIGHT = 96;
export const SKILL_TREE_COL_GAP = 64;
export const SKILL_TREE_ROW_GAP = 16;
export const SKILL_TREE_PADDING = 20;

/** 全图总览紧凑节点与领域分区尺寸常量。 */
export const OVERVIEW_NODE_WIDTH = 152;
export const OVERVIEW_NODE_HEIGHT = 48;
export const OVERVIEW_COL_GAP = 18;
export const OVERVIEW_ROW_GAP = 8;
export const OVERVIEW_CLUSTER_PAD_X = 12;
export const OVERVIEW_CLUSTER_PAD_TOP = 36;
export const OVERVIEW_CLUSTER_PAD_BOTTOM = 12;
export const OVERVIEW_STAGE_GAP = 36;
export const OVERVIEW_CLUSTER_ROW_GAP = 16;
export const OVERVIEW_CANVAS_PAD = 20;

function isCompleted(
  nodeId: string,
  masteryByNode: ReadonlyMap<string, Pick<MasteryItem, 'state'>>,
  placedNodeIds: ReadonlySet<string>,
): boolean {
  return masteryByNode.get(nodeId)?.state === 'mastered' || placedNodeIds.has(nodeId);
}

/**
 * 汇总各领域技能树进度、能力均分、待复习数与题目/讲解覆盖数。
 */
export function summarizeSkillTreeAreas(
  graph: KnowledgeGraph | null,
  masteryByNode: ReadonlyMap<
    string,
    Pick<
      MasteryItem,
      'state' | 'problem_count' | 'ability_score' | 'effective_ability' | 'needs_review'
    >
  > = new Map(),
  placedNodeIds: ReadonlySet<string> = new Set(),
  syllabus = 'all',
): SkillTreeAreaSummary[] {
  if (!graph) return [];
  const normSyllabus = syllabus.trim().toLowerCase();
  const byArea = new Map<string, SkillTreeAreaSummary>();
  const abilitySums = new Map<string, { sum: number; count: number }>();
  for (const area of graph.areas) {
    byArea.set(area.id, {
      id: area.id,
      name: area.name,
      sort: area.sort,
      totalNodes: 0,
      masteredCount: 0,
      learningCount: 0,
      placedCount: 0,
      reviewCount: 0,
      avgAbility: null,
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
    if (mastery?.needs_review) summary.reviewCount++;
    const score = displayAbilityScore(mastery);
    if (score !== null && score > 0) {
      const acc = abilitySums.get(node.area) ?? { sum: 0, count: 0 };
      acc.sum += score;
      acc.count++;
      abilitySums.set(node.area, acc);
    }
    summary.availableProblems += node.problem_count ?? mastery?.problem_count ?? 0;
    if (node.doc) summary.docCount++;
  }
  for (const [areaId, acc] of abilitySums) {
    const summary = byArea.get(areaId);
    if (summary && acc.count > 0) {
      summary.avgAbility = Math.round(acc.sum / acc.count);
    }
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
        abilityScore: displayAbilityScore(mastery),
        needsReview: Boolean(mastery?.needs_review),
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

/**
 * 收集全图范围内某节点的完整上游前置链（`ancestors`）与下游解锁链（`descendants`）。
 *
 * 用于全图总览悬停或选中节点时，跨领域高亮该知识点的学习路径。
 */
export function collectDependencyChain(
  graph: KnowledgeGraph | null,
  nodeId: string,
): { ancestors: Set<string>; descendants: Set<string> } {
  const ancestors = new Set<string>();
  const descendants = new Set<string>();
  if (!graph) return { ancestors, descendants };

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  if (!byId.has(nodeId)) return { ancestors, descendants };

  const dependents = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const req of node.requires) {
      if (!byId.has(req)) continue;
      const list = dependents.get(req) ?? [];
      list.push(node.id);
      dependents.set(req, list);
    }
  }

  const upQueue = [...(byId.get(nodeId)?.requires ?? [])];
  while (upQueue.length > 0) {
    const cur = upQueue.shift()!;
    if (cur === nodeId || ancestors.has(cur) || !byId.has(cur)) continue;
    ancestors.add(cur);
    for (const req of byId.get(cur)!.requires) {
      if (!ancestors.has(req) && req !== nodeId) upQueue.push(req);
    }
  }

  const downQueue = [...(dependents.get(nodeId) ?? [])];
  while (downQueue.length > 0) {
    const cur = downQueue.shift()!;
    if (cur === nodeId || descendants.has(cur) || !byId.has(cur)) continue;
    descendants.add(cur);
    for (const next of dependents.get(cur) ?? []) {
      if (!descendants.has(next) && next !== nodeId) downQueue.push(next);
    }
  }

  return { ancestors, descendants };
}

/**
 * 按领域间跨区依赖推导领域宏观阶段（0 = 底座基础领域，数字越大越进阶）。
 *
 * 若存在领域间双向互引（如 A 中某节点依赖 B，B 中另节点依赖 A），按较强方向
 * （边数多的一侧作为前置方向，相等时按领域 sort）破环，确保确定性分层。
 */
function computeAreaStages(
  areas: readonly { id: string; sort: number }[],
  nodes: readonly KnowledgeNode[],
): Map<string, number> {
  const areaSet = new Set(areas.map((a) => a.id));
  const areaSort = new Map(areas.map((a) => [a.id, a.sort]));
  const nodeArea = new Map(nodes.map((n) => [n.id, n.area]));

  // 统计每对领域之间的有向依赖边数：fromArea -> toArea
  const pairWeight = new Map<string, number>();
  for (const node of nodes) {
    if (!areaSet.has(node.area)) continue;
    for (const req of node.requires) {
      const fromArea = nodeArea.get(req);
      if (!fromArea || fromArea === node.area || !areaSet.has(fromArea)) continue;
      const key = `${fromArea}->${node.area}`;
      pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1);
    }
  }

  // 构建去双向互引后的领域前置表
  const reqAreas = new Map<string, string[]>();
  for (const area of areas) reqAreas.set(area.id, []);
  for (const [key, count] of pairWeight) {
    const [fromArea, toArea] = key.split('->') as [string, string];
    const reverse = pairWeight.get(`${toArea}->${fromArea}`) ?? 0;
    const keep = count > reverse ||
      (count === reverse && (areaSort.get(fromArea) ?? 0) < (areaSort.get(toArea) ?? 0));
    if (keep) {
      reqAreas.get(toArea)!.push(fromArea);
    }
  }

  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  function stageOf(id: string): number {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let maxParent = -1;
    for (const parent of reqAreas.get(id) ?? []) {
      maxParent = Math.max(maxParent, stageOf(parent));
    }
    visiting.delete(id);
    const stage = maxParent + 1;
    memo.set(id, stage);
    return stage;
  }

  for (const area of areas) stageOf(area.id);
  return memo;
}

/**
 * 构建全图总览（全 14 领域分区泳道 + 跨领域依赖连线）的纯拓扑布局。
 *
 * - 外层按领域宏观前置阶段从左到右分列，同列内按领域 sort 垂直堆叠，使跨领域依赖
 *   整体保持从左到右的自然流向；
 * - 每个领域分区内部按拓扑深度紧凑排布节点，输出绝对坐标供缩放/拖拽 SVG 画布渲染。
 */
export function buildGlobalSkillTreeLayout(
  graph: KnowledgeGraph | null,
  options: GlobalSkillTreeLayoutOptions = {},
): GlobalSkillTreeLayoutResult {
  if (!graph || graph.nodes.length === 0) {
    return { clusters: [], nodes: [], edges: [], stageCount: 0, width: 0, height: 0 };
  }
  const masteryByNode = options.masteryByNode ?? new Map();
  const placedNodeIds = options.placedNodeIds ?? new Set<string>();
  const recommendedIds = options.recommendedIds ?? new Set<string>();
  const normSyllabus = (options.syllabus ?? 'all').trim().toLowerCase();
  const nodeLookup = new Map(graph.nodes.map((node) => [node.id, node]));

  const visibleNodes = graph.nodes.filter((node) => {
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

  if (visibleNodes.length === 0) {
    return { clusters: [], nodes: [], edges: [], stageCount: 0, width: 0, height: 0 };
  }

  const visibleSet = new Set(visibleNodes.map((n) => n.id));
  const nodesByArea = new Map<string, KnowledgeNode[]>();
  for (const node of visibleNodes) {
    const list = nodesByArea.get(node.area) ?? [];
    list.push(node);
    nodesByArea.set(node.area, list);
  }

  const activeAreas = graph.areas
    .filter((area) => (nodesByArea.get(area.id)?.length ?? 0) > 0)
    .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));

  const stages = computeAreaStages(activeAreas, visibleNodes);

  // 为每个领域分区先计算紧凑的内部局部坐标与宽高
  interface LocalAreaBox {
    area: { id: string; name: string; sort: number };
    stage: number;
    width: number;
    height: number;
    localNodes: Array<{
      node: KnowledgeNode;
      col: number;
      row: number;
      lx: number;
      ly: number;
    }>;
  }

  const allBoxes: LocalAreaBox[] = [];
  const dependentsGlobal = new Map<string, string[]>();
  for (const node of visibleNodes) {
    for (const req of node.requires) {
      if (!visibleSet.has(req)) continue;
      const list = dependentsGlobal.get(req) ?? [];
      list.push(node.id);
      dependentsGlobal.set(req, list);
    }
  }

  for (const area of activeAreas) {
    const areaNodes = nodesByArea.get(area.id) ?? [];
    const areaNodeSet = new Set(areaNodes.map((n) => n.id));
    const depthMemo = new Map<string, number>();
    const visiting = new Set<string>();
    const depthOf = (id: string): number => {
      const cached = depthMemo.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const node = nodeLookup.get(id);
      let maxParent = -1;
      for (const req of node?.requires ?? []) {
        if (!areaNodeSet.has(req)) continue;
        maxParent = Math.max(maxParent, depthOf(req));
      }
      visiting.delete(id);
      const depth = maxParent + 1;
      depthMemo.set(id, depth);
      return depth;
    };
    for (const n of areaNodes) depthOf(n.id);

    const cols = new Map<number, KnowledgeNode[]>();
    const origOrder = new Map(areaNodes.map((n, i) => [n.id, i]));
    for (const n of areaNodes) {
      const c = depthMemo.get(n.id) ?? 0;
      const list = cols.get(c) ?? [];
      list.push(n);
      cols.set(c, list);
    }
    const maxCol = Math.max(...cols.keys());
    const rowIdx = new Map<string, number>();
    for (let c = 0; c <= maxCol; c++) {
      const list = cols.get(c) ?? [];
      if (c > 0) {
        list.sort((a, b) => {
          const aReqs = a.requires.filter((id) => areaNodeSet.has(id) && rowIdx.has(id));
          const bReqs = b.requires.filter((id) => areaNodeSet.has(id) && rowIdx.has(id));
          const aAvg = aReqs.length > 0
            ? aReqs.reduce((s, id) => s + (rowIdx.get(id) ?? 0), 0) / aReqs.length
            : Number.MAX_SAFE_INTEGER;
          const bAvg = bReqs.length > 0
            ? bReqs.reduce((s, id) => s + (rowIdx.get(id) ?? 0), 0) / bReqs.length
            : Number.MAX_SAFE_INTEGER;
          if (aAvg !== bAvg) return aAvg - bAvg;
          return (origOrder.get(a.id) ?? 0) - (origOrder.get(b.id) ?? 0);
        });
      }
      list.forEach((n, r) => rowIdx.set(n.id, r));
    }

    const colCount = maxCol + 1;
    const maxRows = Math.max(...[...cols.values()].map((l) => l.length));
    const width = OVERVIEW_CLUSTER_PAD_X * 2 +
      colCount * OVERVIEW_NODE_WIDTH +
      Math.max(0, colCount - 1) * OVERVIEW_COL_GAP;
    const height = OVERVIEW_CLUSTER_PAD_TOP +
      OVERVIEW_CLUSTER_PAD_BOTTOM +
      maxRows * OVERVIEW_NODE_HEIGHT +
      Math.max(0, maxRows - 1) * OVERVIEW_ROW_GAP;

    const localNodes: LocalAreaBox['localNodes'] = [];
    for (let c = 0; c <= maxCol; c++) {
      const list = cols.get(c) ?? [];
      for (let r = 0; r < list.length; r++) {
        localNodes.push({
          node: list[r]!,
          col: c,
          row: r,
          lx: OVERVIEW_CLUSTER_PAD_X + c * (OVERVIEW_NODE_WIDTH + OVERVIEW_COL_GAP),
          ly: OVERVIEW_CLUSTER_PAD_TOP + r * (OVERVIEW_NODE_HEIGHT + OVERVIEW_ROW_GAP),
        });
      }
    }

    const stage = stages.get(area.id) ?? 0;
    allBoxes.push({ area, stage, width, height, localNodes });
  }

  // 按宏观前置阶段升序排列后，折叠为最多 3 列高度均衡的视觉泳道，大幅提升全图适配可读性。
  allBoxes.sort((a, b) => a.stage - b.stage || a.area.sort - b.area.sort || a.area.id.localeCompare(b.area.id));
  const distinctRawStages = new Set(allBoxes.map((b) => b.stage)).size;
  const targetCols = Math.min(3, Math.max(1, distinctRawStages));
  const boxesByStage = new Map<number, LocalAreaBox[]>();
  if (distinctRawStages <= targetCols) {
    const rawOrder = [...new Set(allBoxes.map((b) => b.stage))].sort((a, b) => a - b);
    const stageIdx = new Map(rawOrder.map((s, idx) => [s, idx]));
    for (const box of allBoxes) {
      const col = stageIdx.get(box.stage) ?? 0;
      box.stage = col;
      const list = boxesByStage.get(col) ?? [];
      list.push(box);
      boxesByStage.set(col, list);
    }
  } else {
    const totalHeight = allBoxes.reduce((sum, b) => sum + b.height + OVERVIEW_CLUSTER_ROW_GAP, 0);
    const idealColHeight = totalHeight / targetCols;
    let col = 0;
    let colHeight = 0;
    for (let i = 0; i < allBoxes.length; i++) {
      const box = allBoxes[i]!;
      const remainingBoxes = allBoxes.length - i;
      const remainingCols = targetCols - col;
      const list = boxesByStage.get(col) ?? [];
      if (
        list.length > 0 &&
        col < targetCols - 1 &&
        (colHeight + box.height * 0.5 > idealColHeight || remainingBoxes <= remainingCols - 1)
      ) {
        col++;
        colHeight = 0;
      }
      box.stage = col;
      const targetList = boxesByStage.get(col) ?? [];
      targetList.push(box);
      boxesByStage.set(col, targetList);
      colHeight += box.height + OVERVIEW_CLUSTER_ROW_GAP;
    }
  }

  const orderedStages = [...boxesByStage.keys()].sort((a, b) => a - b);
  const clusters: GlobalSkillTreeAreaCluster[] = [];
  const layouts: SkillTreeNodeLayout[] = [];
  const layoutById = new Map<string, SkillTreeNodeLayout>();

  let cursorX = OVERVIEW_CANVAS_PAD;
  let maxCanvasY = OVERVIEW_CANVAS_PAD;

  for (const stage of orderedStages) {
    const boxes = boxesByStage.get(stage) ?? [];
    const stageWidth = Math.max(...boxes.map((b) => b.width));
    let cursorY = OVERVIEW_CANVAS_PAD;

    for (const box of boxes) {
      let masteredCount = 0;
      let placedCount = 0;
      let learningCount = 0;
      let reviewCount = 0;

      const areaNodeSet = new Set(box.localNodes.map((n) => n.node.id));
      for (const local of box.localNodes) {
        const node = local.node;
        const mastery = masteryByNode.get(node.id);
        const state: MasteryState = mastery?.state ?? 'none';
        const allReqsDone = node.requires.every((reqId) => isCompleted(reqId, masteryByNode, placedNodeIds));
        let status: SkillTreeNodeStatus;
        if (state === 'mastered') {
          status = 'mastered';
          masteredCount++;
        } else if (placedNodeIds.has(node.id)) {
          status = 'placed';
          placedCount++;
        } else if (state === 'learning') {
          status = 'learning';
          learningCount++;
        } else if (recommendedIds.has(node.id)) {
          status = 'recommended';
        } else if (allReqsDone) {
          status = 'available';
        } else {
          status = 'locked';
        }
        if (mastery?.needs_review) reviewCount++;

        const requiresInArea = node.requires.filter((id) => areaNodeSet.has(id));
        const externalRequires = node.requires
          .filter((id) => !areaNodeSet.has(id))
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
          column: local.col,
          row: local.row,
          x: cursorX + local.lx,
          y: cursorY + local.ly,
          width: OVERVIEW_NODE_WIDTH,
          height: OVERVIEW_NODE_HEIGHT,
          status,
          solvedCount: mastery?.solved_count ?? 0,
          problemCount: node.problem_count ?? mastery?.problem_count ?? 0,
          abilityScore: displayAbilityScore(mastery),
          needsReview: Boolean(mastery?.needs_review),
          hasDoc: Boolean(node.doc),
          requiresInArea,
          externalRequires,
          dependentsInArea: dependentsGlobal.get(node.id) ?? [],
        };
        layouts.push(item);
        layoutById.set(node.id, item);
      }

      clusters.push({
        areaId: box.area.id,
        name: box.area.name,
        stage,
        x: cursorX,
        y: cursorY,
        width: stageWidth,
        height: box.height,
        nodeCount: box.localNodes.length,
        masteredCount,
        placedCount,
        learningCount,
        reviewCount,
      });

      cursorY += box.height + OVERVIEW_CLUSTER_ROW_GAP;
    }

    maxCanvasY = Math.max(maxCanvasY, cursorY - OVERVIEW_CLUSTER_ROW_GAP + OVERVIEW_CANVAS_PAD);
    cursorX += stageWidth + OVERVIEW_STAGE_GAP;
  }

  const edges: GlobalSkillTreeEdgeLayout[] = [];
  for (const item of layouts) {
    for (const reqId of item.node.requires) {
      const from = layoutById.get(reqId);
      if (!from) continue;
      const crossArea = from.node.area !== item.node.area;
      const x1 = from.x + from.width;
      const y1 = from.y + from.height / 2;
      const x2 = item.x;
      const y2 = item.y + item.height / 2;
      // 跨领域或反向边采用平滑弯曲控制点，避免穿过卡片中心
      const dx = x2 >= x1 ? Math.max(24, (x2 - x1) * 0.45) : Math.max(48, Math.abs(x1 - x2) * 0.3);
      const path = x2 >= x1
        ? `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
        : `M ${x1} ${y1} C ${x1 + dx} ${y1 - 44}, ${x2 - dx} ${y2 + 44}, ${x2} ${y2}`;
      edges.push({
        id: `${from.node.id}->${item.node.id}`,
        fromId: from.node.id,
        toId: item.node.id,
        x1,
        y1,
        x2,
        y2,
        path,
        crossArea,
      });
    }
  }

  const totalWidth = Math.max(
    OVERVIEW_CANVAS_PAD * 2,
    cursorX - OVERVIEW_STAGE_GAP + OVERVIEW_CANVAS_PAD,
  );
  return {
    clusters,
    nodes: layouts,
    edges,
    stageCount: orderedStages.length,
    width: totalWidth,
    height: maxCanvasY,
  };
}
