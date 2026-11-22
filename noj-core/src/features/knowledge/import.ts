/**
 * 内容包导入：把已校验的内容包幂等同步到知识图谱表（单事务）。
 *
 * 语义（openspec「Instance uses one versioned knowledge graph content pack」）：
 * - 实例任一时刻只启用一个包：被导入包 `active = true`，其余包置 false；
 * - 扩展包导入时同时写入被扩展包（最终生效图 = 基础包 + 扩展）；
 * - 上一次生效、但新图中不存在的节点标记 `status = 'deprecated'`（不删除，
 *   `replaced_by` 按包内声明写入或保持原值），新图中的节点为 `active`；
 * - 边：删除新图节点的全部入边后按包重写，保证与新图一致；
 * - 内容未变的节点不重写 `updated_at`，重复导入不产生实际变化。
 */
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { AppError } from "../../shared/base/errors.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  knowledgeAreas,
  knowledgeEdges,
  knowledgeNodes,
  knowledgePacks,
} from "../../shared/db/schema.ts";
import type { DbTx } from "../../shared/db/executor.ts";
import { invalidateKnowledgeGraphCache } from "./graph.ts";
import {
  type KnowledgePack,
  loadPackFromDir,
  resolveOfficialPackDir,
  validatePack,
} from "./pack.ts";
import type { PackArea, PackNode } from "./pack.ts";

/** 内容包校验失败：不写库，消息包含全部校验错误。 */
export class KnowledgePackInvalidError extends AppError {
  /** 逐条校验错误。 */
  readonly errors: readonly string[];

  constructor(packDir: string, errors: readonly string[]) {
    super(
      `知识图谱内容包校验失败（${packDir}）：\n${
        errors.map((item) => `- ${item}`).join("\n")
      }`,
      422,
      "KNOWLEDGE_PACK_INVALID",
      { pack_dir: packDir, errors: [...errors] },
    );
    this.name = "KnowledgePackInvalidError";
    this.errors = [...errors];
  }
}

/** 导入统计。 */
export interface ImportPackResult {
  packId: string;
  version: string;
  /** 实际写入的包（扩展包含被扩展包）。 */
  basePackId: string | null;
  areas: number;
  nodes: number;
  areas_inserted: number;
  areas_updated: number;
  nodes_inserted: number;
  nodes_updated: number;
  nodes_deprecated: number;
  nodes_restored: number;
  edges: number;
}

interface ResolvedGraph {
  /** 先基础包后扩展包。 */
  packs: KnowledgePack[];
  areas: { area: PackArea; packId: string }[];
  nodes: { node: PackNode; packId: string }[];
}

/** 加载并校验内容包（扩展包同时加载官方包）；失败抛 {@link KnowledgePackInvalidError}。 */
export async function loadValidatedGraph(
  packDir: string,
): Promise<ResolvedGraph> {
  const pack = await loadPackFromDir(packDir);
  if (pack.extendsPackId === null) {
    const errors = validatePack(pack);
    if (errors.length > 0) throw new KnowledgePackInvalidError(packDir, errors);
    return flattenGraph([pack]);
  }

  const officialDir = resolveOfficialPackDir();
  const base = await loadPackFromDir(officialDir);
  const baseErrors = validatePack(base);
  const errors = validatePack(pack, {
    base: baseErrors.length === 0 ? base : undefined,
    officialVersion: base.version,
  });
  if (baseErrors.length > 0) errors.unshift(...baseErrors);
  if (errors.length > 0) throw new KnowledgePackInvalidError(packDir, errors);
  return flattenGraph([base, pack]);
}

function flattenGraph(packs: KnowledgePack[]): ResolvedGraph {
  const areas: ResolvedGraph["areas"] = [];
  const nodes: ResolvedGraph["nodes"] = [];
  for (const pack of packs) {
    for (const area of pack.areas) {
      areas.push({ area, packId: pack.id });
      for (const node of area.nodes) nodes.push({ node, packId: pack.id });
    }
  }
  return { packs, areas, nodes };
}

/** 导入内容包（幂等，单事务）。 */
export async function importPack(packDir: string): Promise<ImportPackResult> {
  const graph = await loadValidatedGraph(packDir);
  const db = getDb();
  const result = await db.transaction((tx) => importGraph(tx, graph));
  // 同进程内立即让只读图缓存失效；多副本场景依赖缓存 TTL（见 graph.ts）。
  invalidateKnowledgeGraphCache();
  return result;
}

async function importGraph(
  tx: DbTx,
  graph: ResolvedGraph,
): Promise<ImportPackResult> {
  const now = new Date().toISOString();
  const target = graph.packs[graph.packs.length - 1]!;
  const result: ImportPackResult = {
    packId: target.id,
    version: target.version,
    basePackId: target.extendsPackId,
    areas: graph.areas.length,
    nodes: graph.nodes.length,
    areas_inserted: 0,
    areas_updated: 0,
    nodes_inserted: 0,
    nodes_updated: 0,
    nodes_deprecated: 0,
    nodes_restored: 0,
    edges: 0,
  };

  // ── 包 ──
  const existingPacks = await tx.select().from(knowledgePacks);
  for (const pack of graph.packs) {
    const values = {
      id: pack.id,
      name: pack.name,
      version: pack.version,
      license: pack.license,
      extends: pack.extendsPackId
        ? `${pack.extendsPackId}@${pack.extendsVersion}`
        : null,
      active: pack === target,
      imported_at: now,
    };
    const existing = existingPacks.find((row) => row.id === pack.id);
    const activeChanged = existing ? existing.active !== values.active : true;
    if (
      existing && !activeChanged && existing.name === values.name &&
      existing.version === values.version &&
      existing.license === values.license &&
      existing.extends === values.extends
    ) {
      continue;
    }
    await tx.insert(knowledgePacks).values(values).onConflictDoUpdate({
      target: knowledgePacks.id,
      set: {
        name: values.name,
        version: values.version,
        license: values.license,
        extends: values.extends,
        active: values.active,
        imported_at: now,
      },
    });
  }
  // 其他包置为不生效。
  await tx.update(knowledgePacks).set({ active: false }).where(
    and(
      eq(knowledgePacks.active, true),
      notInArray(knowledgePacks.id, graph.packs.map((pack) => pack.id)),
    ),
  );

  // ── 领域 ──
  const existingAreas = new Map(
    (await tx.select().from(knowledgeAreas)).map((row) => [row.id, row]),
  );
  for (const { area, packId } of graph.areas) {
    const existing = existingAreas.get(area.id);
    const values = {
      id: area.id,
      pack_id: packId,
      name: area.name,
      sort: area.sort,
    };
    if (
      existing && existing.name === area.name && existing.sort === area.sort &&
      existing.pack_id === packId
    ) continue;
    await tx.insert(knowledgeAreas).values(values).onConflictDoUpdate({
      target: knowledgeAreas.id,
      set: { pack_id: packId, name: area.name, sort: area.sort },
    });
    if (existing) result.areas_updated++;
    else result.areas_inserted++;
  }

  // ── 节点 ──
  const existingNodes = new Map(
    (await tx.select().from(knowledgeNodes)).map((row) => [row.id, row]),
  );
  const nodeIds = graph.nodes.map(({ node }) => node.id);
  for (const [nodeIndex, { node, packId }] of graph.nodes.entries()) {
    const existing = existingNodes.get(node.id);
    const values = {
      id: node.id,
      area_id: node.area,
      pack_id: packId,
      name: node.name,
      summary: node.summary,
      syllabus: node.syllabus,
      doc_path: node.doc ?? null,
      status: "active" as const,
      // 包内未声明 replaced_by（P0 格式尚无该字段）时保持既有值，
      // 避免重复导入抹掉历史替换关系。
      replaced_by: existing?.replaced_by ?? null,
      sort: nodeIndex,
    };
    if (!existing) {
      await tx.insert(knowledgeNodes).values({ ...values, updated_at: now });
      result.nodes_inserted++;
      continue;
    }
    const contentChanged = existing.name !== values.name ||
      existing.summary !== values.summary ||
      existing.area_id !== values.area_id ||
      existing.pack_id !== values.pack_id ||
      existing.doc_path !== values.doc_path ||
      existing.sort !== values.sort ||
      JSON.stringify(existing.syllabus) !== JSON.stringify(values.syllabus);
    const statusChanged = existing.status !== "active";
    if (!contentChanged && !statusChanged) continue;
    await tx.update(knowledgeNodes).set({
      ...values,
      updated_at: contentChanged ? now : existing.updated_at,
    }).where(eq(knowledgeNodes.id, node.id));
    if (contentChanged) result.nodes_updated++;
    if (statusChanged) {
      result.nodes_restored++;
      result.nodes_updated++;
    }
  }

  // ── 废弃新图中不存在的节点（不删除）──
  const previousNodeIds = [...existingNodes.keys()];
  const gone = previousNodeIds.filter((id) => !nodeIds.includes(id));
  if (gone.length > 0) {
    const deprecated = await tx.update(knowledgeNodes).set({
      status: "deprecated",
      updated_at: now,
    })
      .where(
        and(
          inArray(knowledgeNodes.id, gone),
          eq(knowledgeNodes.status, "active"),
        ),
      )
      .returning({ id: knowledgeNodes.id });
    result.nodes_deprecated = deprecated.length;
  }

  // ── 边：删除新图节点的全部入边后重写 ──
  const activeIds = [...nodeIds, ...gone];
  if (activeIds.length > 0) {
    await tx.delete(knowledgeEdges).where(
      inArray(knowledgeEdges.to_id, activeIds),
    );
  }
  const edgeRows: { from_id: string; to_id: string }[] = [];
  for (const { node } of graph.nodes) {
    for (const from of node.requires) {
      edgeRows.push({ from_id: from, to_id: node.id });
    }
  }
  if (edgeRows.length > 0) await tx.insert(knowledgeEdges).values(edgeRows);
  result.edges = edgeRows.length;

  return result;
}
