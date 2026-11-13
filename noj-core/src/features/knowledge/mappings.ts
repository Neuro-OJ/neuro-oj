/**
 * 题目—知识点挂载：读取、人工挂载、审核与 AI 结果落库。
 *
 * 归类语义（见 openspec/changes/add-knowledge-graph/design.md 第 5 节）：
 * - 已归类 = 存在一条 `role='primary'` 且 `review_status <> 'rejected'` 的挂载；
 *   `pending` 也计入已归类（界面标注「待确认」）。
 * - 人工挂载（`source='human'`）整体替换该题全部挂载，AI 不覆盖人工。
 * - 节点 `deprecated` 时挂载保留（表里不动），读取时过滤；若主知识点被过滤，
 *   该题按未归类处理。
 * - 题目处于进行中比赛或保密保护期时，非编辑者读到 `null`（路由转 404），
 *   与域内题目详情「内容入口单独授权」的口径一致。
 *
 * 题目标识：本功能统一使用**题目内部 ID**（`problems.id`，UUID），与
 * `/api/v1/problems/:id`、`/api/v1/admin/catalog/problems/:id` 一致；路由层
 * 只接受 UUID（见 `parseProblemId`）。
 */
import { and, count, eq, inArray, ne } from "drizzle-orm";
import type { UserActor } from "../../modules/access/contracts/actor.ts";
import { loadDomainProblemProtection } from "../../modules/access/index.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  knowledgeNodes,
  problemKnowledge,
  problems,
} from "../../shared/db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../shared/base/errors.ts";
import { assertProblemEditPermissionForActor } from "../../modules/problems/index.ts";
import { recordAudit } from "../../modules/platform/index.ts";
import type { AuditDetail } from "../../modules/platform/index.ts";

/** 每题最多次要知识点数。 */
export const MAX_SECONDARY_NODES = 3;

/** 挂载条目读取视图。 */
export interface KnowledgeMappingEntry {
  node_id: string;
  name: string;
  role: "primary" | "secondary";
  source: "ai" | "human";
  /** 0–100；人工挂载为 null。 */
  confidence: number | null;
  review_status: "auto" | "pending" | "confirmed" | "rejected";
  version_id: string | null;
  updated_at: string;
}

/** 题目归类视图（`GET /knowledge/problems/:problemId` 的 `data`）。 */
export interface ProblemKnowledgeView {
  problem_id: string;
  state: "classified" | "unclassified";
  primary: KnowledgeMappingEntry | null;
  secondary: KnowledgeMappingEntry[];
  /** 存在待确认挂载（主或次）；界面据此标注「待确认」。 */
  pending: boolean;
}

/** 读接口的查看者：`userId` 为空表示未登录。 */
export interface KnowledgeViewer {
  userId: string | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 路由层解析题目 ID：只接受内部 UUID，其余一律 400。 */
export function parseProblemId(raw: string | undefined): string {
  if (!raw || !UUID_PATTERN.test(raw)) {
    throw new BadRequestError("problemId 必须是题目内部 ID（UUID）");
  }
  return raw;
}

/** 规范化知识点 ID 数组：字符串、去空、去重。 */
function normalizeNodeIds(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ValidationError(`${field} 必须是知识点 ID 数组`);
  }
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new ValidationError(`${field} 含非法的知识点 ID`);
    }
    const id = item.trim();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 人工挂载输入。 */
export interface ManualMappingInput {
  primary: string;
  secondary: string[];
}

/** 把请求体规范化为挂载输入并做业务校验（不改库）。 */
function normalizeManualInput(body: unknown): ManualMappingInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("请求体必须是对象");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.primary !== "string" || record.primary.trim() === "") {
    throw new ValidationError("primary 必须是非空知识点 ID");
  }
  const primary = record.primary.trim();
  const secondary = normalizeNodeIds(record.secondary, "secondary");
  if (secondary.includes(primary)) {
    throw new ValidationError("secondary 不能包含 primary");
  }
  if (secondary.length > MAX_SECONDARY_NODES) {
    throw new ValidationError(
      `secondary 最多 ${MAX_SECONDARY_NODES} 个知识点`,
    );
  }
  return { primary, secondary };
}

/** 断言节点存在且 active（deprecated 不允许新挂载）。 */
async function assertActiveNodes(ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows = await getDb().select({
    id: knowledgeNodes.id,
    status: knowledgeNodes.status,
  }).from(knowledgeNodes).where(inArray(knowledgeNodes.id, unique));
  const status = new Map(rows.map((row) => [row.id, row.status]));
  for (const id of unique) {
    const value = status.get(id);
    if (value === undefined) {
      throw new ValidationError(`知识点不存在：${id}`);
    }
    if (value !== "active") {
      throw new ValidationError(`知识点已废弃，不能再挂载：${id}`);
    }
  }
}

/** 读取题目基础行（不存在时 404）。 */
async function requireProblem(problemId: string) {
  const [row] = await getDb().select().from(problems).where(
    eq(problems.id, problemId),
  );
  if (!row) throw new NotFoundError("题目不存在");
  return {
    id: row.id,
    title: row.title,
    domain_id: row.domain_id,
    owner_id: row.owner_id,
  };
}

/** 当前用户对该题是否有内容编辑权限；平台管理员（root）视为有。 */
async function canEditProblem(
  row: { id: string; domain_id: string | null; owner_id: string },
  actor: UserActor,
): Promise<boolean> {
  if (actor.userId === "0") return true;
  try {
    await assertProblemEditPermissionForActor(row, actor);
    return true;
  } catch {
    return false;
  }
}

/** 题目是否处于比赛保密保护期（进行中 / 未到 end_time 的保密赛）。 */
async function isProtected(row: {
  id?: string;
  problem_id?: string;
  domain_id: string | null;
}): Promise<boolean> {
  const problemId = row.id ?? row.problem_id;
  if (!row.domain_id || !problemId) return false;
  const refs = await loadDomainProblemProtection(row.domain_id, [problemId]);
  return (refs.get(problemId) ?? []).length > 0;
}

/** 行投影为读取条目。 */
function toEntry(
  row: {
    node_id: string;
    name: string;
    role: string;
    source: string;
    confidence: number | null;
    review_status: string;
    version_id: string | null;
    updated_at: string;
  },
): KnowledgeMappingEntry {
  return {
    node_id: row.node_id,
    name: row.name,
    role: row.role as KnowledgeMappingEntry["role"],
    source: row.source as KnowledgeMappingEntry["source"],
    confidence: row.confidence,
    review_status: row.review_status as KnowledgeMappingEntry["review_status"],
    version_id: row.version_id,
    updated_at: row.updated_at,
  };
}

/** 读取挂载行（排除 rejected 与 deprecated 节点；主知识点在前）。 */
async function loadMappingRows(problemIds: string[]) {
  if (problemIds.length === 0) return [];
  return await getDb().select({
    problem_id: problemKnowledge.problem_id,
    node_id: problemKnowledge.node_id,
    name: knowledgeNodes.name,
    role: problemKnowledge.role,
    source: problemKnowledge.source,
    confidence: problemKnowledge.confidence,
    review_status: problemKnowledge.review_status,
    version_id: problemKnowledge.version_id,
    updated_at: problemKnowledge.updated_at,
  }).from(problemKnowledge)
    .innerJoin(knowledgeNodes, eq(knowledgeNodes.id, problemKnowledge.node_id))
    .where(and(
      inArray(problemKnowledge.problem_id, problemIds),
      ne(problemKnowledge.review_status, "rejected"),
      eq(knowledgeNodes.status, "active"),
    ))
    .orderBy(problemKnowledge.role, knowledgeNodes.sort, knowledgeNodes.id);
}

/** 行组装为题目归类视图。 */
function buildView(
  problemId: string,
  rows: ReturnType<typeof toEntry>[],
): ProblemKnowledgeView {
  const primary = rows.find((entry) => entry.role === "primary") ?? null;
  return {
    problem_id: problemId,
    state: primary ? "classified" : "unclassified",
    primary,
    secondary: rows.filter((entry) => entry.role === "secondary"),
    pending: rows.some((entry) => entry.review_status === "pending"),
  };
}

/**
 * 读取题目归类。
 *
 * @param viewer 查看者；`userId` 为空表示未登录
 * @returns 题目不存在 → 404；保密保护期且无编辑权限 → null（路由转 404）
 */
export async function readProblemKnowledge(
  problemId: string,
  viewer: KnowledgeViewer,
): Promise<ProblemKnowledgeView | null> {
  const row = await requireProblem(problemId);
  // 保护期内只有编辑者（与平台管理员）能看到知识点（design.md 第 11 节）。
  if (await isProtected(row)) {
    const allowed = viewer.userId
      ? await canEditProblem(row, {
        kind: "user",
        userId: viewer.userId,
      } as UserActor)
      : false;
    if (!allowed) return null;
  }
  const rows = (await loadMappingRows([problemId])).map(toEntry);
  return buildView(problemId, rows);
}

/** 审计细节：挂载类操作共用 `knowledge.mapping.update`。 */
function mappingDetail(extra: Record<string, unknown>): AuditDetail {
  return {
    action: "knowledge.mapping.update",
    ...extra,
  } as unknown as AuditDetail;
}

/** 整体替换挂载（事务内先删后插；调用方负责权限与节点校验）。 */
async function replaceMappings(
  problemId: string,
  input: ManualMappingInput,
  values: {
    source: "ai" | "human";
    review_status: "auto" | "pending" | "confirmed";
    confidence: number | null;
    version_id: string | null;
  },
  updatedBy: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const rows = [
    { node_id: input.primary, role: "primary" as const },
    ...input.secondary.map((node_id) => ({
      node_id,
      role: "secondary" as const,
    })),
  ];
  await getDb().transaction(async (tx) => {
    await tx.delete(problemKnowledge).where(
      eq(problemKnowledge.problem_id, problemId),
    );
    await tx.insert(problemKnowledge).values(
      rows.map((item) => ({
        problem_id: problemId,
        node_id: item.node_id,
        role: item.role,
        source: values.source,
        confidence: values.confidence,
        version_id: values.version_id,
        review_status: values.review_status,
        updated_by: updatedBy,
        updated_at: now,
      })),
    );
  });
}

/**
 * 人工挂载：整体替换该题全部挂载为 `source='human', review_status='confirmed'`。
 *
 * 权限 = 题目编辑权限（`assertProblemEditPermissionForActor`）或实例管理员。
 *
 * @throws {ValidationError} 节点不存在/已废弃、secondary 超限或含 primary
 * @throws {ForbiddenError} 无编辑权限且非实例管理员
 */
export async function setProblemKnowledgeManually(
  actor: UserActor,
  problemId: string,
  rawInput: unknown,
  meta: { ipAddress: string; requestId?: string },
): Promise<ProblemKnowledgeView> {
  const input = normalizeManualInput(rawInput);
  const row = await requireProblem(problemId);
  if (!(await canEditProblem(row, actor))) {
    throw new ForbiddenError("无权修改该题目的知识点");
  }
  await assertActiveNodes([input.primary, ...input.secondary]);
  await replaceMappings(problemId, input, {
    source: "human",
    review_status: "confirmed",
    confidence: null,
    version_id: null,
  }, actor.userId);
  await recordAudit(
    actor,
    meta,
    "knowledge.mapping.update",
    mappingDetail({
      primary: input.primary,
      secondary: input.secondary,
    }),
    { type: "problem", id: problemId },
  );
  return (await readProblemKnowledge(problemId, {
    userId: actor.userId,
  }))!;
}

/** 审核列表条目。 */
export interface PendingMappingItem {
  problem_id: string;
  title: string;
  domain_id: string | null;
  primary: KnowledgeMappingEntry | null;
  secondary: KnowledgeMappingEntry[];
  updated_at: string;
}

/**
 * 待审核挂载分页（至少一条 `pending` 的题目）。
 *
 * 保密保护期的题目不出现在队列里（design.md 第 11 节可见性）。
 */
export async function listPendingMappings(
  page: { page: number; limit: number },
): Promise<{
  items: PendingMappingItem[];
  total: number;
  page: number;
  limit: number;
}> {
  const db = getDb();
  const pendingProblems = db.selectDistinct({
    problem_id: problemKnowledge.problem_id,
  }).from(problemKnowledge).where(
    eq(problemKnowledge.review_status, "pending"),
  ).as("pending_problems");
  const [totalRow] = await db.select({ value: count() }).from(
    pendingProblems,
  );
  const rows = await db.select({
    problem_id: problems.id,
    title: problems.title,
    domain_id: problems.domain_id,
  }).from(pendingProblems)
    .innerJoin(problems, eq(problems.id, pendingProblems.problem_id))
    .orderBy(problems.updated_at, problems.id)
    .limit(page.limit)
    .offset((page.page - 1) * page.limit);
  const entries = await loadMappingRows(rows.map((row) => row.problem_id));
  const items: PendingMappingItem[] = [];
  for (const row of rows) {
    if (await isProtected(row)) continue;
    const own = entries.filter((entry) => entry.problem_id === row.problem_id)
      .map(toEntry);
    items.push({
      problem_id: row.problem_id,
      title: row.title,
      domain_id: row.domain_id,
      primary: own.find((entry) => entry.role === "primary") ?? null,
      secondary: own.filter((entry) => entry.role === "secondary"),
      updated_at: own[0]?.updated_at ?? "",
    });
  }
  return { items, total: totalRow?.value ?? 0, ...page };
}

/** 审核决定：接受 / 驳回 / 直接给出人工挂载。 */
export type MappingDecision =
  | "accept"
  | "reject"
  | { primary: string; secondary: string[] };

/**
 * 审核一条待确认挂载（实例管理员）。
 *
 * - `accept`：该题全部 `pending` 挂载转 `confirmed`；
 * - `reject`：该题全部 `pending` 挂载转 `rejected`；若该题已有
 *   `confirmed`/`auto` 主知识点则不变，否则题目回到未归类；
 * - 修改：等同人工挂载（整体替换为 `confirmed`）。
 */
export async function reviewMapping(
  actor: UserActor,
  problemId: string,
  decision: MappingDecision,
  meta: { ipAddress: string; requestId?: string },
): Promise<ProblemKnowledgeView> {
  const row = await requireProblem(problemId);
  // 保护期题目不暴露知识点，也不允许在审核队列里操作。
  if (await isProtected(row)) {
    throw new NotFoundError("题目不存在");
  }
  if (typeof decision !== "string") {
    return await setProblemKnowledgeManually(actor, problemId, decision, meta);
  }
  const now = new Date().toISOString();
  await getDb().update(problemKnowledge).set({
    review_status: decision === "accept" ? "confirmed" : "rejected",
    updated_by: actor.userId,
    updated_at: now,
  }).where(and(
    eq(problemKnowledge.problem_id, problemId),
    eq(problemKnowledge.review_status, "pending"),
  ));
  await recordAudit(
    actor,
    meta,
    "knowledge.mapping.update",
    mappingDetail({ decision, problem_title: row.title }),
    { type: "problem", id: problemId },
  );
  return (await readProblemKnowledge(problemId, {
    userId: actor.userId,
  }))!;
}

/** AI 打标结果（置信度为 0–1 小数）。 */
export interface AiMappingResult {
  primary: string;
  secondary?: string[];
  confidence: number;
}

/** `applyAiMapping` 的结局。 */
export type ApplyAiMappingOutcome = "applied" | "skipped";

/** 数据层当前的挂载状态快照（供任务去重用）。 */
export interface CurrentMappingState {
  has_human: boolean;
  rows: { node_id: string; role: "primary" | "secondary" }[];
}

/** 读取当前挂载（排除 rejected）快照。 */
export async function loadCurrentMappingState(
  problemId: string,
): Promise<CurrentMappingState> {
  const rows = await getDb().select({
    node_id: problemKnowledge.node_id,
    role: problemKnowledge.role,
    source: problemKnowledge.source,
    review_status: problemKnowledge.review_status,
  }).from(problemKnowledge).where(eq(problemKnowledge.problem_id, problemId));
  return {
    has_human: rows.some((row) => row.source === "human"),
    rows: rows
      .filter((row) => row.review_status !== "rejected")
      .map((row) => ({
        node_id: row.node_id,
        role: row.role as "primary" | "secondary",
      })),
  };
}

/**
 * 落库 AI 打标结果（供 `knowledge.tag` 任务使用，任务 C 调用）。
 *
 * - 已有人工挂载（任意 `source='human'` 行）→ 不覆盖，返回 `skipped`；
 * - 置信度 ≥ `threshold` → `auto`，否则 `pending`；
 * - 替换该题之前全部 AI 挂载；
 * - 未知/废弃节点、secondary 超限或含 primary → 抛 `ValidationError`
 *   （调用方负责重试一次后记失败）。
 *
 * @throws {NotFoundError} 题目不存在
 * @throws {ValidationError} 结果不合法
 */
export async function applyAiMapping(
  problemId: string,
  versionId: string | null,
  result: AiMappingResult,
  threshold: number,
): Promise<{ outcome: ApplyAiMappingOutcome }> {
  await requireProblem(problemId);
  const input = normalizeManualInput({
    primary: result.primary,
    secondary: result.secondary ?? [],
  });
  const state = await loadCurrentMappingState(problemId);
  if (state.has_human) return { outcome: "skipped" };
  await assertActiveNodes([input.primary, ...input.secondary]);
  const ratio = Number.isFinite(result.confidence) ? result.confidence : 0;
  const confidence = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const limit = Number.isFinite(threshold) ? threshold : 0.75;
  await replaceMappings(problemId, input, {
    source: "ai",
    review_status: ratio >= limit ? "auto" : "pending",
    confidence,
    version_id: versionId,
  }, null);
  return { outcome: "applied" };
}
