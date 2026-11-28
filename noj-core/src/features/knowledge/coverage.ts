/**
 * 知识图谱覆盖度面板（P3，聚合 SQL 一次取数，不逐节点查询）。
 *
 * 从 `mastery.ts` 拆出以保持单文件规模低于门禁上限；仍由 `mastery.ts` 与 `index.ts` 重新导出。
 */
import { sql } from "drizzle-orm";
import { unwrapRows } from "../../shared/base/sql-rows.ts";
import { getDb } from "../../shared/db/connection.ts";
import type { DbRoot } from "../../shared/db/executor.ts";
import { tierOf } from "./difficulty.ts";
import { readKnowledgeGraph } from "./graph.ts";
import {
  loadNodeProblems,
  loadProtectedProblems,
  masteryMinSolved,
  scoreOfNodeProblem,
} from "./mastery.ts";

/**
 * 待确认挂载（`review_status = 'pending'`）的节点题目行（仅覆盖度题量用）。
 *
 * 口径与 {@link loadNodeProblems} 相同，仅放宽 `review_status`。
 */
async function loadNodePendingCounts(
  db: DbRoot = getDb(),
): Promise<{ node_id: string; problem_id: string; domain_id: string }[]> {
  const rows = await db.execute(sql`
    SELECT pk.node_id, p.id AS problem_id, p.domain_id
    FROM problem_knowledge pk
    JOIN knowledge_nodes kn ON kn.id = pk.node_id AND kn.status = 'active'
    JOIN problems p ON p.id = pk.problem_id
    JOIN domains d ON d.id = p.domain_id
    JOIN domain_problem_bindings b
      ON b.domain_id = p.domain_id AND b.problem_id = p.id
    WHERE pk.role = 'primary'
      AND pk.review_status = 'pending'
      AND b.disabled_at IS NULL
      AND d.status <> 'suspended'
      AND p.latest_version_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM problem_versions v WHERE v.problem_id = p.id
        AND v.id = CASE WHEN p.effective_version_mode = 'exact'
          THEN p.required_version_id ELSE p.latest_version_id END)
  `);
  return unwrapRows(rows as never) as {
    node_id: string;
    problem_id: string;
    domain_id: string;
  }[];
}

/** 单节点覆盖度（三档计数 + 缺口标记）。 */
export interface CoverageNodeItem {
  node_id: string;
  name: string;
  area: string;
  /** 三档（校准难度派生：<34 easy、<67 medium、其余 hard）计数。 */
  difficulty_distribution: { easy: number; medium: number; hard: number };
  problem_count: number;
  /** 题量不足：题数小于「已掌握」所需达标题数 K。 */
  insufficient_problems: boolean;
  /** 难度断层：无校准难度位于上三分之一的题目。 */
  difficulty_gap: boolean;
}

/** 覆盖度视图。 */
export interface CoverageView {
  /** 指定域时的域；未指定为 null（跨域汇总）。 */
  domain: { id: string; slug: string } | null;
  min_solved: number;
  totals: {
    nodes: number;
    nodes_with_problems: number;
    insufficient_problems: number;
    difficulty_gap: number;
    problems: number;
  };
  nodes: CoverageNodeItem[];
  /** 未归类题目数（该域已发布题目中无有效主知识点）。 */
  unclassified_problems: number;
  /** 待确认挂载数。 */
  pending_mappings: number;
  /** 失效挂载数（`deprecated` 节点上的有效挂载）。 */
  deprecated_mappings: number;
  /** 保护期内（进行中比赛 / 保密保护）被排除统计的题目数。 */
  protected_problems: number;
}

/**
 * 覆盖度面板（聚合 SQL 一次取数，不逐节点查询）。
 *
 * 保护期题目按 access 口径排除（与阶梯、掌握度一致）。`domainId` 为空时统计
 * 全部域（实例管理员视图）。
 */
export async function readCoverage(
  domain: { id: string; slug: string } | null,
  db: DbRoot = getDb(),
): Promise<CoverageView> {
  const graph = await readKnowledgeGraph();
  const rows = await loadNodeProblems(db);
  const scoped = domain
    ? rows.filter((row) => row.domain_id === domain.id)
    : rows;
  const protectedIds = await loadProtectedProblems(scoped);
  const visible = scoped.filter((row) => !protectedIds.has(row.problem_id));
  const byNode = new Map<string, number[]>();
  for (const row of visible) {
    const list = byNode.get(row.node_id) ?? [];
    list.push(scoreOfNodeProblem(row));
    byNode.set(row.node_id, list);
  }
  // 待确认挂载（pending）的题量计入「题量不足」判定，但不进难度分布、
  // 也不参与难度断层判定（难度未知，避免误报断层）。
  const byNodePending = new Map<string, number>();
  for (const row of await loadNodePendingCounts(db)) {
    if (domain && row.domain_id !== domain.id) continue;
    if (protectedIds.has(row.problem_id)) continue;
    byNodePending.set(
      row.node_id,
      (byNodePending.get(row.node_id) ?? 0) + 1,
    );
  }
  const minSolved = masteryMinSolved();
  const areaSort = new Map(graph.areas.map((area) => [area.id, area.sort]));
  const nodes: CoverageNodeItem[] = [];
  // 域视图只展开该域有题的知识点；实例管理员未指定域时展开全部节点。
  const nodesInDomain = domain
    ? new Set([
      ...scoped.map((row) => row.node_id),
      ...byNodePending.keys(),
    ])
    : null;
  for (const node of graph.nodes) {
    if (nodesInDomain && !nodesInDomain.has(node.id)) continue;
    const scores = byNode.get(node.id) ?? [];
    const pendingCount = byNodePending.get(node.id) ?? 0;
    const distribution = { easy: 0, medium: 0, hard: 0 };
    for (const score of scores) distribution[tierOf(score)]++;
    const problemCount = scores.length + pendingCount;
    const insufficient = problemCount < minSolved;
    nodes.push({
      node_id: node.id,
      name: node.name,
      area: node.area,
      difficulty_distribution: distribution,
      problem_count: problemCount,
      insufficient_problems: insufficient,
      // 难度断层：题量已足（题量不足另有标记）但没有一道「困难」档题目
      //（校准难度位于 0–100 的上三分之一）。不能用节点内相对上三分之一——
      // 一组题永远有相对最难的那几道，会让断层永远判不出来。
      difficulty_gap: !insufficient && scores.length > 0 &&
        distribution.hard === 0,
    });
  }
  nodes.sort((a, b) =>
    (areaSort.get(a.area) ?? 0) - (areaSort.get(b.area) ?? 0) ||
    graph.nodes.findIndex((node) => node.id === a.node_id) -
      graph.nodes.findIndex((node) => node.id === b.node_id)
  );

  const domainFilter = domain ? sql`AND p.domain_id = ${domain.id}` : sql``;
  const counts = await db.execute<{
    unclassified_problems: number;
    pending_mappings: number;
    deprecated_mappings: number;
  }>(sql`
    WITH candidate AS (
      SELECT p.id
      FROM problems p
      JOIN domains d ON d.id = p.domain_id
      JOIN domain_problem_bindings b
        ON b.domain_id = p.domain_id AND b.problem_id = p.id
      WHERE p.latest_version_id IS NOT NULL
        AND b.disabled_at IS NULL
        AND d.status <> 'suspended'
        ${domainFilter}
    )
    SELECT
      (SELECT count(*)::int FROM candidate c
        WHERE NOT EXISTS (
          SELECT 1 FROM problem_knowledge pk
          WHERE pk.problem_id = c.id AND pk.role = 'primary'
            AND pk.review_status IN ('auto', 'confirmed', 'pending')
        )) AS unclassified_problems,
      (SELECT count(DISTINCT pk.problem_id)::int FROM problem_knowledge pk
        JOIN candidate c ON c.id = pk.problem_id
        WHERE pk.review_status = 'pending') AS pending_mappings,
      (SELECT count(*)::int FROM problem_knowledge pk
        JOIN problems p ON p.id = pk.problem_id
        JOIN knowledge_nodes kn ON kn.id = pk.node_id
        WHERE pk.review_status IN ('auto', 'confirmed')
          AND kn.status = 'deprecated'
          ${domainFilter}) AS deprecated_mappings
  `);
  const totals_ = (unwrapRows(counts as never) as {
    unclassified_problems: number;
    pending_mappings: number;
    deprecated_mappings: number;
  }[])[0] ?? {
    unclassified_problems: 0,
    pending_mappings: 0,
    deprecated_mappings: 0,
  };
  return {
    domain,
    min_solved: minSolved,
    totals: {
      nodes: nodes.length,
      nodes_with_problems:
        nodes.filter((node) => node.problem_count > 0).length,
      insufficient_problems:
        nodes.filter((node) => node.insufficient_problems).length,
      difficulty_gap: nodes.filter((node) => node.difficulty_gap).length,
      problems: nodes.reduce((sum, node) => sum + node.problem_count, 0),
    },
    nodes,
    unclassified_problems: totals_.unclassified_problems,
    pending_mappings: totals_.pending_mappings,
    deprecated_mappings: totals_.deprecated_mappings,
    protected_problems: scoped.length - visible.length,
  };
}
