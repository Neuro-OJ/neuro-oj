/**
 * 知识图谱只读视图：进程内缓存 + 领域/节点/前置边组装。
 *
 * 数据来源：`knowledge_*` 四张表（见 `src/shared/db/schema/knowledge.ts`）。
 * 只读取当前生效包（`knowledge_packs.active = true`）下 `status = 'active'`
 * 的领域与节点；边只保留两端都 active 的前置关系。
 *
 * 缓存：只读、可容忍短暂不一致，按根 AGENTS.md 多副本约束使用进程内 TTL 缓存
 * （10 分钟），详见 `dev-docs/engineering/domain-boundaries.md`。导入新包后各副本
 * 最迟 10 分钟可见；同进程导入成功后会主动调用
 * {@link invalidateKnowledgeGraphCache}。
 */
import { eq, inArray } from "drizzle-orm";
import { NotFoundError } from "../../shared/base/errors.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  knowledgeAreas,
  knowledgeEdges,
  knowledgeNodes,
  knowledgePacks,
} from "../../shared/db/schema.ts";

/** 缓存 TTL（毫秒）。 */
export const KNOWLEDGE_GRAPH_CACHE_TTL_MS = 10 * 60 * 1000;

/** 图接口中的领域。 */
export interface KnowledgeGraphArea {
  id: string;
  name: string;
  sort: number;
}

/** 图接口中的节点。 */
export interface KnowledgeGraphNode {
  id: string;
  area: string;
  name: string;
  summary: string;
  syllabus: string[];
  /** 直接前置节点 ID（仅 active）。 */
  requires: string[];
  doc: string | null;
}

/** 图接口返回体（`data` 部分）。 */
export interface KnowledgeGraphView {
  pack: { id: string; version: string } | null;
  areas: KnowledgeGraphArea[];
  nodes: KnowledgeGraphNode[];
}

/** 节点详情返回体（`data` 部分）。 */
export interface KnowledgeNodeView {
  id: string;
  area: string;
  name: string;
  summary: string;
  syllabus: string[];
  doc: string | null;
  requires: string[];
  /** 直接后继节点 ID（仅 active）。 */
  dependents: string[];
}

interface CacheEntry {
  view: KnowledgeGraphView;
  expiresAt: number;
}

let cache: CacheEntry | null = null;
/** 并发未命中合并：多个请求共用一次回源。 */
let inflight: Promise<KnowledgeGraphView> | null = null;

/** 清空图缓存（导入成功、测试重置时调用）。 */
export function invalidateKnowledgeGraphCache(): void {
  cache = null;
  inflight = null;
}

/** 从库读取整图（无缓存）。 */
async function loadGraph(): Promise<KnowledgeGraphView> {
  const db = getDb();
  const [packs, areas, nodes, edges] = await Promise.all([
    db.select().from(knowledgePacks).where(eq(knowledgePacks.active, true)),
    db.select().from(knowledgeAreas),
    db.select().from(knowledgeNodes).where(eq(knowledgeNodes.status, "active")),
    db.select().from(knowledgeEdges),
  ]);

  const pack = packs.length > 0
    ? { id: packs[0]!.id, version: packs[0]!.version }
    : null;

  const viewAreas: KnowledgeGraphArea[] = areas.map((row) => ({
    id: row.id,
    name: row.name,
    sort: row.sort,
  })).sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  const areaOrder = new Map(viewAreas.map((area, index) => [area.id, index]));
  const areaIds = new Set(viewAreas.map((area) => area.id));

  const activeNodes = nodes.filter((node) => areaIds.has(node.area_id)).sort(
    (a, b) => a.sort - b.sort || a.id.localeCompare(b.id),
  );
  const activeIds = new Set(activeNodes.map((node) => node.id));

  const requiresOf = new Map<string, string[]>();
  for (const edge of edges) {
    if (!activeIds.has(edge.from_id) || !activeIds.has(edge.to_id)) continue;
    const list = requiresOf.get(edge.to_id) ?? [];
    list.push(edge.from_id);
    requiresOf.set(edge.to_id, list);
  }
  for (const list of requiresOf.values()) list.sort();

  const viewNodes: KnowledgeGraphNode[] = activeNodes.map((node) => ({
    id: node.id,
    area: node.area_id,
    name: node.name,
    summary: node.summary,
    syllabus: [...node.syllabus],
    requires: requiresOf.get(node.id) ?? [],
    doc: node.doc_path,
  })).sort((a, b) =>
    (areaOrder.get(a.area) ?? 0) - (areaOrder.get(b.area) ?? 0)
  );

  return { pack, areas: viewAreas, nodes: viewNodes };
}

/** 读取整图（带进程内 TTL 缓存）。 */
export async function readKnowledgeGraph(): Promise<KnowledgeGraphView> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.view;
  inflight ??= loadGraph();
  try {
    const view = await inflight;
    cache = { view, expiresAt: Date.now() + KNOWLEDGE_GRAPH_CACHE_TTL_MS };
    return view;
  } finally {
    inflight = null;
  }
}

/** 读取节点详情；不存在或已废弃抛 404。requires/dependents 只含 active 节点。 */
export async function readKnowledgeNode(
  id: string,
): Promise<KnowledgeNodeView> {
  const db = getDb();
  const [row] = await db.select().from(knowledgeNodes).where(
    eq(knowledgeNodes.id, id),
  );
  if (!row || row.status !== "active") {
    throw new NotFoundError("知识点不存在");
  }
  const [inEdges, outEdges] = await Promise.all([
    db.select().from(knowledgeEdges).where(eq(knowledgeEdges.to_id, id)),
    db.select().from(knowledgeEdges).where(eq(knowledgeEdges.from_id, id)),
  ]);
  const neighbourIds = [
    ...new Set([
      ...inEdges.map((edge) => edge.from_id),
      ...outEdges.map((edge) => edge.to_id),
    ]),
  ];
  const activeIds = new Set<string>();
  if (neighbourIds.length > 0) {
    const rows = await db.select({
      id: knowledgeNodes.id,
      status: knowledgeNodes.status,
    }).from(knowledgeNodes).where(inArray(knowledgeNodes.id, neighbourIds));
    for (const item of rows) {
      if (item.status === "active") activeIds.add(item.id);
    }
  }
  const keepActive = (ids: string[]) =>
    ids.filter((value) => activeIds.has(value)).sort();
  return {
    id: row.id,
    area: row.area_id,
    name: row.name,
    summary: row.summary,
    syllabus: [...row.syllabus],
    doc: row.doc_path,
    requires: keepActive(inEdges.map((edge) => edge.from_id)),
    dependents: keepActive(outEdges.map((edge) => edge.to_id)),
  };
}
