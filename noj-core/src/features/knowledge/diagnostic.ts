/**
 * 摸底诊断与前置能力自评（冷启动激活技能树，不污染真实做题掌握度）。
 *
 * - 将用户通过摸底勾选或达标的自评前置记录保存在独立表 `user_knowledge_placements`，
 *   与 {@link userKnowledgeMastery} 严格隔离，避免伪造 `solved_count` 或污染班级矩阵。
 * - 推荐与前沿诊断将「已掌握 或 已摸底解锁」视为满足前置，从而让有基础的选手
 *   直接从中高阶前沿节点起步，同时技能树以专属状态（`placed`）展示差异。
 */
import { and, eq, inArray } from "drizzle-orm";
import { userActorFromAuthenticatedId } from "../../modules/access/contracts/actor.ts";
import { BadRequestError, ValidationError } from "../../shared/base/errors.ts";
import { getDb } from "../../shared/db/connection.ts";
import type { DbRoot } from "../../shared/db/executor.ts";
import { userKnowledgePlacements } from "../../shared/db/schema.ts";
import { type LadderItem, readNodeLadder } from "./difficulty.ts";
import { type KnowledgeGraphView, readKnowledgeGraph } from "./graph.ts";
import {
  loadNodeProblems,
  loadUserMastery,
  loadUserPlacementIds,
  type MasteryState,
} from "./mastery.ts";

/** 摸底诊断单次返回的最多检查点数量。 */
export const DIAGNOSTIC_MAX_CHECKPOINTS = 8;

/** 每次自评提交允许的最多节点数。 */
export const MAX_SELF_ASSESS_NODES = 200;

/** 领域级自评汇总（供冷启动快速勾选基础领域）。 */
export interface DiagnosticAreaSummary {
  area_id: string;
  name: string;
  total_nodes: number;
  foundation_node_ids: string[];
  mastered_count: number;
  placed_count: number;
}

/** 摸底检查点（带后继解锁影响度与可选试做题）。 */
export interface DiagnosticCheckpoint {
  node_id: string;
  name: string;
  area: string;
  area_name: string;
  summary: string;
  has_doc: boolean;
  /** 直接或间接依赖该节点作为前置的下游节点数。 */
  unlocks_count: number;
  problem_count: number;
  sample_problem: LadderItem | null;
  state: MasteryState;
  placed: boolean;
}

/** 摸底诊断计划视图（`GET /knowledge/me/diagnostic`）。 */
export interface DiagnosticPlanView {
  domain: { id: string; slug: string } | null;
  placed_nodes: string[];
  areas: DiagnosticAreaSummary[];
  checkpoints: DiagnosticCheckpoint[];
}

/** 自评/标熟提交请求。 */
export interface SelfAssessInput {
  node_ids?: unknown;
  area_ids?: unknown;
  mode?: unknown;
  /** 可选：标熟时一并标熟全部上游前置知识点（仅 merge / replace 生效）。 */
  include_prerequisites?: unknown;
}

/** 自评/标熟提交结果。 */
export interface SelfAssessResult {
  placed_nodes: string[];
  added_count: number;
  removed_count: number;
  total_placed: number;
}

/**
 * 纯函数：收集给定节点集合在图谱中的全部上游前置知识点 ID（不含缺失节点，防环）。
 */
export function collectPrerequisiteIds(
  graph: Pick<KnowledgeGraphView, "nodes">,
  seedIds: Iterable<string>,
): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const result = new Set<string>();
  const queue: string[] = [];
  for (const id of seedIds) {
    const node = byId.get(id);
    if (!node) continue;
    for (const req of node.requires) {
      if (byId.has(req) && !result.has(req)) {
        result.add(req);
        queue.push(req);
      }
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const node = byId.get(cur);
    if (!node) continue;
    for (const req of node.requires) {
      if (byId.has(req) && !result.has(req)) {
        result.add(req);
        queue.push(req);
      }
    }
  }
  return result;
}

/**
 * 纯函数：计算图中每个节点能直接或间接解锁的下游节点数量。
 *
 * 用于优先挑选对技能树影响面最大的检查点，减少冷启动题目数量。
 */
export function computeDownstreamReach(
  graph: Pick<KnowledgeGraphView, "nodes">,
): Map<string, number> {
  const dependents = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const req of node.requires) {
      const list = dependents.get(req) ?? [];
      list.push(node.id);
      dependents.set(req, list);
    }
  }
  const reach = new Map<string, number>();
  for (const node of graph.nodes) {
    const visited = new Set<string>();
    const queue = [...(dependents.get(node.id) ?? [])];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur) || cur === node.id) continue;
      visited.add(cur);
      for (const next of dependents.get(cur) ?? []) {
        if (!visited.has(next)) queue.push(next);
      }
    }
    reach.set(node.id, visited.size);
  }
  return reach;
}

/**
 * 纯函数：为每个领域筛选适合作为摸底入口的基础节点。
 *
 * 规则：领域内优先返回「无域内前置」的根节点，若领域较深也纳入拓扑较浅节点（全部 active 节点，供快速整区解锁）。
 */
export function collectAreaFoundationNodes(
  graph: Pick<KnowledgeGraphView, "nodes">,
): Map<string, string[]> {
  const byArea = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const list = byArea.get(node.area) ?? [];
    list.push(node.id);
    byArea.set(node.area, list);
  }
  return byArea;
}

/**
 * 纯函数：从图谱中挑选最多 `limit` 个高杠杆摸底检查点。
 *
 * 原则：
 * 1. 优先未掌握且尚未 placed 的节点，若不足再用已有节点补位展示状态；
 * 2. 尽量分散到不同领域（每领域先选影响面最大的核心桥接/基础节点）；
 * 3. 在指定域内有练习题或有原创讲解的节点优先。
 */
export function selectDiagnosticCheckpoints(
  graph: Pick<KnowledgeGraphView, "areas" | "nodes">,
  input: {
    stateOf: (nodeId: string) => MasteryState;
    isPlaced: (nodeId: string) => boolean;
    countOf: (nodeId: string) => number;
    limit?: number;
  },
): Array<{ node: KnowledgeGraphView["nodes"][number]; unlocksCount: number }> {
  const limit = input.limit ?? DIAGNOSTIC_MAX_CHECKPOINTS;
  const reach = computeDownstreamReach(graph);
  const areaSort = new Map(graph.areas.map((a) => [a.id, a.sort]));

  const scored = graph.nodes.map((node, index) => {
    const mastered = input.stateOf(node.id) === "mastered";
    const placed = input.isPlaced(node.id);
    const unlocksCount = reach.get(node.id) ?? 0;
    const hasProblem = input.countOf(node.id) > 0;
    const isRootOrBridge = node.requires.length <= 1;
    // 未掌握/未自评最优先 -> 有题优先 -> 基础/桥接节点 -> 解锁影响面降序 -> 领域顺位
    const score = (mastered ? -10_000 : 0) +
      (placed ? -1_000 : 0) +
      (hasProblem ? 200 : 0) +
      (node.doc ? 50 : 0) +
      (isRootOrBridge ? 40 : 0) +
      Math.min(unlocksCount * 5, 150);
    return {
      node,
      unlocksCount,
      score,
      areaSort: areaSort.get(node.area) ?? 0,
      index,
    };
  });

  scored.sort((a, b) =>
    b.score - a.score ||
    a.areaSort - b.areaSort ||
    a.index - b.index
  );

  // 第一轮每个领域最多挑 1 个最有代表性的检查点，避免全挤在同一个领域
  const picked: Array<{
    node: KnowledgeGraphView["nodes"][number];
    unlocksCount: number;
  }> = [];
  const usedIds = new Set<string>();
  const usedAreas = new Set<string>();

  for (const item of scored) {
    if (picked.length >= limit) break;
    if (usedAreas.has(item.node.area)) continue;
    usedAreas.add(item.node.area);
    usedIds.add(item.node.id);
    picked.push({ node: item.node, unlocksCount: item.unlocksCount });
  }
  for (const item of scored) {
    if (picked.length >= limit) break;
    if (usedIds.has(item.node.id)) continue;
    usedIds.add(item.node.id);
    picked.push({ node: item.node, unlocksCount: item.unlocksCount });
  }
  return picked;
}

/** 读取当前用户的摸底诊断计划（领域概览 + 推荐检查点 + 已解锁节点）。 */
export async function readDiagnosticPlan(
  userId: string,
  domain: { id: string; slug: string } | null,
  db: DbRoot = getDb(),
): Promise<DiagnosticPlanView> {
  const graph = await readKnowledgeGraph();
  const [mastery, placedIds, rows] = await Promise.all([
    loadUserMastery(userId, db),
    loadUserPlacementIds(userId, db),
    loadNodeProblems(db),
  ]);

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (domain && row.domain_id !== domain.id) continue;
    counts.set(row.node_id, (counts.get(row.node_id) ?? 0) + 1);
  }

  const areaNodes = collectAreaFoundationNodes(graph);
  const areas: DiagnosticAreaSummary[] = graph.areas.map((area) => {
    const nodeIds = areaNodes.get(area.id) ?? [];
    let masteredCount = 0;
    let placedCount = 0;
    for (const id of nodeIds) {
      if (mastery.get(id)?.state === "mastered") masteredCount++;
      if (placedIds.has(id)) placedCount++;
    }
    return {
      area_id: area.id,
      name: area.name,
      total_nodes: nodeIds.length,
      foundation_node_ids: nodeIds,
      mastered_count: masteredCount,
      placed_count: placedCount,
    };
  });

  const selected = selectDiagnosticCheckpoints(graph, {
    stateOf: (id) => mastery.get(id)?.state ?? "none",
    isPlaced: (id) => placedIds.has(id),
    countOf: (id) => counts.get(id) ?? 0,
    limit: DIAGNOSTIC_MAX_CHECKPOINTS,
  });

  const areaNameById = new Map(graph.areas.map((a) => [a.id, a.name]));
  const viewer = userActorFromAuthenticatedId(userId);
  const checkpoints: DiagnosticCheckpoint[] = [];
  for (const { node, unlocksCount } of selected) {
    let sampleProblem: LadderItem | null = null;
    if (domain && (counts.get(node.id) ?? 0) > 0) {
      try {
        sampleProblem = (await readNodeLadder(node.id, domain.slug, viewer))
          ?.next ?? null;
      } catch {
        sampleProblem = null;
      }
    }
    checkpoints.push({
      node_id: node.id,
      name: node.name,
      area: node.area,
      area_name: areaNameById.get(node.area) ?? node.area,
      summary: node.summary,
      has_doc: Boolean(node.doc),
      unlocks_count: unlocksCount,
      problem_count: counts.get(node.id) ?? 0,
      sample_problem: sampleProblem,
      state: mastery.get(node.id)?.state ?? "none",
      placed: placedIds.has(node.id),
    });
  }

  return {
    domain,
    placed_nodes: [...placedIds].sort(),
    areas,
    checkpoints,
  };
}

function parseIdList(
  raw: unknown,
  field: string,
  maxItems: number,
): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ValidationError(`${field} 必须是字符串数组`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new ValidationError(`${field} 包含非法标识`);
    }
    const id = item.trim();
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  if (out.length > maxItems) {
    throw new ValidationError(`${field} 数量不得超过 ${maxItems}`);
  }
  return out;
}

/**
 * 保存/移除用户摸底自评与一键标熟结果（写入 `user_knowledge_placements`，不触碰做题掌握度）。
 *
 * - `mode = 'merge'`（默认）：增量标熟指定节点（可选 `include_prerequisites: true` 级联前置）；
 * - `mode = 'replace'`：整体替换 `self_assessed` 集合（保留 `diagnostic_passed`）；
 * - `mode = 'remove'`：取消标熟指定节点。
 */
export async function saveSelfAssessedPlacements(
  userId: string,
  input: SelfAssessInput,
  db: DbRoot = getDb(),
): Promise<SelfAssessResult> {
  const modeRaw = input.mode;
  const mode = modeRaw === undefined || modeRaw === null ? "merge" : modeRaw;
  if (mode !== "merge" && mode !== "replace" && mode !== "remove") {
    throw new BadRequestError("mode 仅支持 merge、replace 或 remove");
  }
  const includePrereqsRaw = input.include_prerequisites;
  if (
    includePrereqsRaw !== undefined &&
    includePrereqsRaw !== null &&
    typeof includePrereqsRaw !== "boolean"
  ) {
    throw new ValidationError("include_prerequisites 必须是布尔值");
  }
  const includePrerequisites = includePrereqsRaw === true;

  const graph = await readKnowledgeGraph();
  const validNodeIds = new Set(graph.nodes.map((n) => n.id));
  const areaMap = new Map(graph.areas.map((a) => [a.id, a]));
  const areaNodes = collectAreaFoundationNodes(graph);

  const requestedNodes = parseIdList(
    input.node_ids,
    "node_ids",
    MAX_SELF_ASSESS_NODES,
  );
  const requestedAreas = parseIdList(input.area_ids, "area_ids", 30);

  for (const nodeId of requestedNodes) {
    if (!validNodeIds.has(nodeId)) {
      throw new ValidationError(`未知或已废弃的知识点：${nodeId}`);
    }
  }
  for (const areaId of requestedAreas) {
    if (!areaMap.has(areaId)) {
      throw new ValidationError(`未知领域：${areaId}`);
    }
  }

  const targetIds = new Set<string>(requestedNodes);
  for (const areaId of requestedAreas) {
    for (const nodeId of areaNodes.get(areaId) ?? []) {
      targetIds.add(nodeId);
    }
  }
  if (includePrerequisites && mode !== "remove" && targetIds.size > 0) {
    for (const reqId of collectPrerequisiteIds(graph, targetIds)) {
      targetIds.add(reqId);
    }
  }
  if (targetIds.size > MAX_SELF_ASSESS_NODES) {
    throw new ValidationError(
      `单次自评最多提交 ${MAX_SELF_ASSESS_NODES} 个知识点`,
    );
  }

  const existingBefore = await loadUserPlacementIds(userId, db);
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    const list = [...targetIds];
    if (mode === "remove") {
      if (list.length > 0) {
        await tx.delete(userKnowledgePlacements).where(
          and(
            eq(userKnowledgePlacements.user_id, userId),
            inArray(userKnowledgePlacements.node_id, list),
          ),
        );
      }
      return;
    }

    if (mode === "replace") {
      await tx.delete(userKnowledgePlacements).where(
        and(
          eq(userKnowledgePlacements.user_id, userId),
          eq(userKnowledgePlacements.source, "self_assessed"),
        ),
      );
    }
    if (list.length > 0) {
      if (mode === "merge") {
        // 确保只写未覆盖行，保留已有 diagnostic_passed 来源
        const toInsert = list.filter((id) => !existingBefore.has(id));
        if (toInsert.length > 0) {
          await tx.insert(userKnowledgePlacements).values(
            toInsert.map((nodeId) => ({
              user_id: userId,
              node_id: nodeId,
              source: "self_assessed",
              created_at: now,
            })),
          ).onConflictDoNothing();
        }
      } else {
        // replace 模式先清除了 self_assessed，过滤掉仍存在的 diagnostic_passed
        const rows = await tx.select({
          node_id: userKnowledgePlacements.node_id,
        }).from(userKnowledgePlacements).where(
          and(
            eq(userKnowledgePlacements.user_id, userId),
            inArray(userKnowledgePlacements.node_id, list),
          ),
        );
        const protectedSet = new Set(rows.map((r) => r.node_id));
        const toInsert = list.filter((id) => !protectedSet.has(id));
        if (toInsert.length > 0) {
          await tx.insert(userKnowledgePlacements).values(
            toInsert.map((nodeId) => ({
              user_id: userId,
              node_id: nodeId,
              source: "self_assessed",
              created_at: now,
            })),
          ).onConflictDoNothing();
        }
      }
    }
  });

  const existingAfter = await loadUserPlacementIds(userId, db);
  let addedCount = 0;
  for (const id of existingAfter) {
    if (!existingBefore.has(id)) addedCount++;
  }
  let removedCount = 0;
  for (const id of existingBefore) {
    if (!existingAfter.has(id)) removedCount++;
  }
  return {
    placed_nodes: [...existingAfter].sort(),
    added_count: addedCount,
    removed_count: removedCount,
    total_placed: existingAfter.size,
  };
}
