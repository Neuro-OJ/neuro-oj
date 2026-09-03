/**
 * 题单（training）服务层（issue #224）。
 *
 * 职责：
 * - 题单 CRUD 与可见性访问控制
 * - 题单题目管理（加题 / 重排 / 移除）
 * - AC 进度聚合（编程题 finished 且 score>0 + 客观题满分）
 *
 * 权限约定：
 * - 路由层负责 RBAC 权限判定；服务层做所有权/可见性兜底（fail-closed）。
 * - `visibility=public` 仅管理员（`training:publish`）可设置；
 *   `is_pinned` 仅管理员（`training:pin`）可设置。
 */

import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import {
  evaluationResults,
  objectiveSubmissions,
  problems,
  submissions,
  trainingProblems,
  trainings,
} from "./../../../shared/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import {
  generatePublicId,
  resolvePublicId,
} from "./../../../shared/security/public-id.ts";
import { resolveProblemIdOrThrow } from "./problem-resolve.ts";
import {
  type CreateTrainingInput,
  isValidTrainingVisibility,
  type TrainingProblemResponse,
  type TrainingResponse,
  type TrainingVisibility,
  type UpdateTrainingInput,
} from "./../types/trainings.ts";

/** 题单列表分页参数。 */
export interface ListTrainingsParams {
  page?: number;
  perPage?: number;
}

/** 题单列表分页结果。 */
export interface ListTrainingsResult {
  data: TrainingResponse[];
  total: number;
}

/** 更新题单时的权限选项。 */
export interface UpdateTrainingOptions {
  /** 是否可编辑任意题单（admin / training:write_any） */
  isAdmin?: boolean;
  /** 是否可将可见性设为 public（training:publish） */
  canPublish?: boolean;
  /** 是否可设置 is_pinned（training:pin） */
  canPin?: boolean;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * 规范化分页参数：page 至少为 1，perPage 限制在 [1, MAX_PAGE_SIZE]。
 *
 * @param params 原始分页参数
 * @returns 规范化后的 page、perPage 与 offset
 */
function normalizePage(params: ListTrainingsParams): {
  page: number;
  perPage: number;
  offset: number;
} {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, params.perPage ?? DEFAULT_PAGE_SIZE),
  );
  return { page, perPage, offset: (page - 1) * perPage };
}

/**
 * 批量统计各题单的题目数量。
 *
 * @param trainingIds 题单 id 列表
 * @returns 题单 id → 题目数的映射
 */
async function countProblems(
  trainingIds: string[],
): Promise<Map<string, number>> {
  if (trainingIds.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({
      training_id: trainingProblems.training_id,
      count: sql<number>`count(*)::int`,
    })
    .from(trainingProblems)
    .where(inArray(trainingProblems.training_id, trainingIds))
    .groupBy(trainingProblems.training_id);
  return new Map(rows.map((r) => [r.training_id, r.count]));
}

/**
 * 将题单数据库行转换为响应 DTO。
 *
 * @param row 题单数据库行
 * @param problemCount 该题单的题目数
 * @returns 题单响应 DTO
 */
function toResponse(
  row: typeof trainings.$inferSelect,
  problemCount: number,
): TrainingResponse {
  return {
    id: row.id,
    public_id: row.public_id,
    title: row.title,
    description: row.description,
    visibility: row.visibility as TrainingVisibility,
    is_pinned: row.is_pinned,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    problem_count: problemCount,
  };
}

/**
 * 列出公开（visibility=public）题单，置顶优先、按更新时间倒序。
 *
 * @param params 分页参数
 * @returns 公开题单分页结果
 */
export async function listPublicTrainings(
  params: ListTrainingsParams,
): Promise<ListTrainingsResult> {
  const db = getDb();
  const { perPage, offset } = normalizePage(params);
  const where = eq(trainings.visibility, "public");
  const [rows, totalRows] = await Promise.all([
    db.select().from(trainings).where(where)
      .orderBy(desc(trainings.is_pinned), desc(trainings.updated_at))
      .limit(perPage).offset(offset),
    db.select({ total: count() }).from(trainings).where(where),
  ]);
  const counts = await countProblems(rows.map((r) => r.id));
  const data = rows.map((r) => toResponse(r, counts.get(r.id) ?? 0));
  return { data, total: totalRows[0]?.total ?? 0 };
}

/**
 * 列出当前用户创建的题单（含 private），按更新时间倒序。
 *
 * @param userId 当前用户 id
 * @param params 分页参数
 * @returns 我的题单分页结果
 */
export async function listMyTrainings(
  userId: string,
  params: ListTrainingsParams,
): Promise<ListTrainingsResult> {
  const db = getDb();
  const { perPage, offset } = normalizePage(params);
  const where = eq(trainings.created_by, userId);
  const [rows, totalRows] = await Promise.all([
    db.select().from(trainings).where(where)
      .orderBy(desc(trainings.updated_at))
      .limit(perPage).offset(offset),
    db.select({ total: count() }).from(trainings).where(where),
  ]);
  const counts = await countProblems(rows.map((r) => r.id));
  const data = rows.map((r) => toResponse(r, counts.get(r.id) ?? 0));
  return { data, total: totalRows[0]?.total ?? 0 };
}

/**
 * 返回当前用户创建、且包含指定题目的题单 id 列表。
 * 用于题目页「加入题单」弹窗预勾选已含该题的题单。
 */
export async function listTrainingsContainingProblem(
  userId: string,
  problemId: string,
): Promise<string[]> {
  const db = getDb();
  const resolvedProblemId = await resolveProblemId(problemId);
  const rows = await db
    .select({ id: trainings.id })
    .from(trainings)
    .innerJoin(
      trainingProblems,
      eq(trainings.id, trainingProblems.training_id),
    )
    .where(and(
      eq(trainings.created_by, userId),
      eq(trainingProblems.problem_id, resolvedProblemId),
    ));
  return rows.map((r) => r.id);
}

/**
 * 列出全部题单（管理端，含 private），按更新时间倒序。
 *
 * @param params 分页参数
 * @returns 全部题单分页结果
 */
export async function listAllTrainings(
  params: ListTrainingsParams,
): Promise<ListTrainingsResult> {
  const db = getDb();
  const { perPage, offset } = normalizePage(params);
  const [rows, totalRows] = await Promise.all([
    db.select().from(trainings)
      .orderBy(desc(trainings.updated_at))
      .limit(perPage).offset(offset),
    db.select({ total: count() }).from(trainings),
  ]);
  const counts = await countProblems(rows.map((r) => r.id));
  const data = rows.map((r) => toResponse(r, counts.get(r.id) ?? 0));
  return { data, total: totalRows[0]?.total ?? 0 };
}

/**
 * 列出指定用户创建的题单；非 owner/admin 仅可见 public。
 *
 * @param ownerId 题单所属用户 id
 * @param viewerId 查看者 id（可选）
 * @param isAdmin 查看者是否为管理员
 * @param params 分页参数
 * @returns 该用户的题单分页结果
 */
export async function listUserTrainings(
  ownerId: string,
  viewerId?: string,
  isAdmin = false,
  params: ListTrainingsParams = {},
): Promise<ListTrainingsResult> {
  const db = getDb();
  const { perPage, offset } = normalizePage(params);
  const isOwner = ownerId === viewerId || isAdmin;
  const conditions = [eq(trainings.created_by, ownerId)];
  if (!isOwner) conditions.push(eq(trainings.visibility, "public"));
  const where = and(...conditions);
  const [rows, totalRows] = await Promise.all([
    db.select().from(trainings).where(where)
      .orderBy(desc(trainings.is_pinned), desc(trainings.updated_at))
      .limit(perPage).offset(offset),
    db.select({ total: count() }).from(trainings).where(where),
  ]);
  const counts = await countProblems(rows.map((r) => r.id));
  const data = rows.map((r) => toResponse(r, counts.get(r.id) ?? 0));
  return { data, total: totalRows[0]?.total ?? 0 };
}

/**
 * 获取单个题单详情；private 题单仅 owner/admin 可见（对外表现为不存在）。
 *
 * @param id 题单内部 UUID
 * @param viewerId 查看者 id（可选）
 * @param isAdmin 查看者是否为管理员
 * @returns 题单响应 DTO
 * @throws {NotFoundError} 题单不存在或无权查看
 */
export async function getTraining(
  id: string,
  viewerId?: string,
  isAdmin = false,
): Promise<TrainingResponse> {
  const db = getDb();
  const [row] = await db.select().from(trainings).where(eq(trainings.id, id))
    .limit(1);
  if (!row) throw new NotFoundError("题单不存在");
  if (row.visibility === "private" && row.created_by !== viewerId && !isAdmin) {
    throw new NotFoundError("题单不存在");
  }
  const counts = await countProblems([row.id]);
  return toResponse(row, counts.get(row.id) ?? 0);
}

/**
 * 创建题单（可见性仅允许 private 或 unlisted，public 需管理员）。
 *
 * @param input 创建题单输入
 * @param userId 创建者用户 id
 * @returns 新建的题单响应 DTO
 * @throws {BadRequestError} 标题为空/超长，或可见性非法
 */
export async function createTraining(
  input: CreateTrainingInput,
  userId: string,
): Promise<TrainingResponse> {
  const title = input.title?.trim();
  if (!title || title.length > 100) {
    throw new BadRequestError("题单标题必须为 1-100 字符");
  }
  const visibility = input.visibility ?? "private";
  if (!isValidTrainingVisibility(visibility) || visibility === "public") {
    throw new BadRequestError("创建题单时可见性只能为 private 或 unlisted");
  }
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const publicId = generatePublicId("tr");
  await db.insert(trainings).values({
    id,
    public_id: publicId,
    title,
    description: input.description?.trim() ?? "",
    visibility,
    is_pinned: false,
    created_by: userId,
    created_at: now,
    updated_at: now,
  });
  return getTraining(id, userId);
}

/** 将 UUID 或 public_id 解析为内部题单 UUID；其它格式按主键兜底。 */
export function resolveTrainingId(value: string): Promise<string> {
  return resolvePublicId(
    trainings,
    trainings.id,
    trainings.public_id,
    "tr",
    value,
    "题单不存在",
  );
}

/**
 * 更新题单（标题/描述/可见性/置顶）。
 *
 * @param id 题单内部 UUID
 * @param input 更新输入（仅更新提供的字段）
 * @param actorId 操作者用户 id
 * @param options 权限选项（isAdmin / canPublish / canPin）
 * @returns 更新后的题单响应 DTO
 * @throws {NotFoundError} 题单不存在
 * @throws {ForbiddenError} 无权编辑、置顶或设为公开
 * @throws {BadRequestError} 可见性非法或标题为空/超长
 */
export async function updateTraining(
  id: string,
  input: UpdateTrainingInput,
  actorId: string,
  options: UpdateTrainingOptions = {},
): Promise<TrainingResponse> {
  const { isAdmin = false, canPublish = isAdmin, canPin = isAdmin } = options;
  const db = getDb();
  const [row] = await db.select().from(trainings).where(eq(trainings.id, id))
    .limit(1);
  if (!row) throw new NotFoundError("题单不存在");
  if (row.created_by !== actorId && !isAdmin) {
    throw new ForbiddenError("无权编辑该题单");
  }
  if (input.is_pinned !== undefined && !canPin) {
    throw new ForbiddenError("无权置顶题单");
  }
  if (input.visibility === "public" && !canPublish) {
    throw new ForbiddenError("无权将题单设为公开");
  }
  if (
    input.visibility !== undefined &&
    !isValidTrainingVisibility(input.visibility)
  ) {
    throw new BadRequestError("可见性不合法");
  }
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title || title.length > 100) {
      throw new BadRequestError("题单标题必须为 1-100 字符");
    }
  }
  const next = {
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    ...(input.description !== undefined
      ? { description: input.description.trim() }
      : {}),
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    ...(input.is_pinned !== undefined ? { is_pinned: input.is_pinned } : {}),
    updated_at: new Date().toISOString(),
  };
  await db.update(trainings).set(next).where(eq(trainings.id, id));
  return getTraining(id, actorId, isAdmin);
}

/**
 * 删除题单。
 *
 * @param id 题单内部 UUID
 * @param actorId 操作者用户 id
 * @param isAdmin 操作者是否为管理员
 * @throws {NotFoundError} 题单不存在
 * @throws {ForbiddenError} 无权删除该题单
 */
export async function deleteTraining(
  id: string,
  actorId: string,
  isAdmin = false,
): Promise<void> {
  const db = getDb();
  const [row] = await db.select().from(trainings).where(eq(trainings.id, id))
    .limit(1);
  if (!row) throw new NotFoundError("题单不存在");
  if (row.created_by !== actorId && !isAdmin) {
    throw new ForbiddenError("无权删除该题单");
  }
  await db.delete(trainings).where(eq(trainings.id, id));
}

// ── 题单题目管理与进度聚合 ──────────────────────────────

/**
 * 断言操作者有权编辑指定题单（owner 或 admin），并返回题单行。
 *
 * @param trainingId 题单内部 UUID
 * @param actorId 操作者用户 id
 * @param isAdmin 操作者是否为管理员
 * @returns 题单数据库行
 * @throws {NotFoundError} 题单不存在
 * @throws {ForbiddenError} 无权编辑该题单
 */
async function assertWritable(
  trainingId: string,
  actorId: string,
  isAdmin: boolean,
): Promise<typeof trainings.$inferSelect> {
  const db = getDb();
  const [row] = await db.select().from(trainings).where(
    eq(trainings.id, trainingId),
  )
    .limit(1);
  if (!row) throw new NotFoundError("题单不存在");
  if (row.created_by !== actorId && !isAdmin) {
    throw new ForbiddenError("无权编辑该题单");
  }
  return row;
}

/**
 * 计算用户对给定题目集合的 AC 集合。
 * 编程题：finished 且 score>0；客观题：满分（score=10000）。
 *
 * @param userId 用户 id
 * @param problemIds 题目 id 列表
 * @returns 已 AC 的题目 id 集合
 */
async function getAcceptedProblemIds(
  userId: string,
  problemIds: string[],
): Promise<Set<string>> {
  if (problemIds.length === 0) return new Set();
  const db = getDb();
  const acceptedRows = await db
    .select({ problem_id: submissions.problem_id })
    .from(submissions)
    .innerJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    )
    .where(and(
      eq(submissions.user_id, userId),
      inArray(submissions.problem_id, problemIds),
      eq(submissions.status, "finished"),
      sql`${evaluationResults.score} > 0`,
    ));
  const objectiveRows = await db
    .select({ paper_id: objectiveSubmissions.paper_id })
    .from(objectiveSubmissions)
    .where(and(
      eq(objectiveSubmissions.user_id, userId),
      inArray(objectiveSubmissions.paper_id, problemIds),
      eq(objectiveSubmissions.score, 10000),
    ));
  return new Set([
    ...acceptedRows.map((r) => r.problem_id),
    ...objectiveRows.map((r) => r.paper_id),
  ]);
}

/**
 * 列出题单内题目（按 position 升序），并标注查看者的 AC 状态。
 *
 * @param trainingId 题单内部 UUID
 * @param viewerId 查看者 id（可选，未登录不标注 AC）
 * @param isAdmin 查看者是否为管理员
 * @returns 题单题目列表
 * @throws {NotFoundError} 题单不存在或无权查看
 */
export async function listTrainingProblems(
  trainingId: string,
  viewerId?: string,
  isAdmin = false,
): Promise<TrainingProblemResponse[]> {
  await getTraining(trainingId, viewerId, isAdmin);
  const db = getDb();
  const rows = await db
    .select({
      training_id: trainingProblems.training_id,
      problem_id: trainingProblems.problem_id,
      position: trainingProblems.position,
      title: problems.title,
      description: problems.description,
      difficulty: problems.difficulty,
      display_id: sql<string>`${problems.type} || ${problems.number}`,
      type: problems.type,
      is_objective: problems.is_objective,
    })
    .from(trainingProblems)
    .innerJoin(problems, eq(trainingProblems.problem_id, problems.id))
    .where(eq(trainingProblems.training_id, trainingId))
    .orderBy(asc(trainingProblems.position));
  const accepted = viewerId
    ? await getAcceptedProblemIds(viewerId, rows.map((r) => r.problem_id))
    : new Set<string>();
  return rows.map((r) => ({ ...r, accepted: accepted.has(r.problem_id) }));
}

/**
 * 将题目标识（display_id 如 P1001/U42，或 UUID）解析为内部题目 UUID。
 *
 * @param input 题目标识
 * @returns 内部题目 UUID
 * @throws {NotFoundError} 题目不存在
 */
function resolveProblemId(input: string): Promise<string> {
  return resolveProblemIdOrThrow(input.trim());
}

/**
 * 向题单添加题目；未指定 position 时追加到末尾，否则插入并后移后续题目。
 *
 * @param trainingId 题单内部 UUID
 * @param problemId 题目标识（display_id 或 UUID）
 * @param position 目标位置（可选，非负整数）
 * @param actorId 操作者用户 id
 * @param isAdmin 操作者是否为管理员
 * @returns 新增的题单题目
 * @throws {NotFoundError} 题单/题目不存在
 * @throws {ForbiddenError} 无权编辑该题单
 * @throws {ConflictError} 该题目已在题单中
 * @throws {BadRequestError} position 非法
 */
export async function addTrainingProblem(
  trainingId: string,
  problemId: string,
  position: number | undefined,
  actorId: string,
  isAdmin = false,
): Promise<TrainingProblemResponse> {
  await assertWritable(trainingId, actorId, isAdmin);
  const db = getDb();
  const resolvedProblemId = await resolveProblemId(problemId);
  const [problem] = await db.select().from(problems).where(
    eq(problems.id, resolvedProblemId),
  )
    .limit(1);
  if (!problem) throw new NotFoundError("题目不存在");
  const [existing] = await db
    .select()
    .from(trainingProblems)
    .where(and(
      eq(trainingProblems.training_id, trainingId),
      eq(trainingProblems.problem_id, resolvedProblemId),
    ))
    .limit(1);
  if (existing) throw new ConflictError("该题目已在题单中");
  if (position !== undefined && (!Number.isInteger(position) || position < 0)) {
    throw new BadRequestError("position 必须为非负整数");
  }

  const nextPosition = await db.transaction(async (tx) => {
    let target = position;
    if (target === undefined) {
      const [maxRow] = await tx
        .select({
          max: sql<number>`coalesce(max(${trainingProblems.position}), -1)`,
        })
        .from(trainingProblems)
        .where(eq(trainingProblems.training_id, trainingId));
      target = (maxRow?.max ?? -1) + 1;
    } else {
      await tx
        .update(trainingProblems)
        .set({ position: sql`${trainingProblems.position} + 1` })
        .where(and(
          eq(trainingProblems.training_id, trainingId),
          gte(trainingProblems.position, target),
        ));
    }
    await tx.insert(trainingProblems).values({
      training_id: trainingId,
      problem_id: resolvedProblemId,
      position: target,
    });
    return target;
  });

  return {
    training_id: trainingId,
    problem_id: resolvedProblemId,
    position: nextPosition,
    title: problem.title,
    description: problem.description,
    difficulty: problem.difficulty,
    display_id: `${problem.type}${problem.number}`,
    type: problem.type,
    is_objective: problem.is_objective,
    accepted: false,
  };
}

/**
 * 重排题单内题目顺序（须包含题单当前全部题目，position 唯一且非负）。
 *
 * @param trainingId 题单内部 UUID
 * @param problemsInput 题目 id 与目标 position 的数组
 * @param actorId 操作者用户 id
 * @param isAdmin 操作者是否为管理员
 * @returns 重排后的题单题目列表
 * @throws {NotFoundError} 题单不存在
 * @throws {ForbiddenError} 无权编辑该题单
 * @throws {BadRequestError} 输入非法（重复/缺题/position 非法）
 */
export async function reorderTrainingProblems(
  trainingId: string,
  problemsInput: { problem_id: string; position: number }[],
  actorId: string,
  isAdmin = false,
): Promise<TrainingProblemResponse[]> {
  await assertWritable(trainingId, actorId, isAdmin);
  const db = getDb();
  const existing = await db
    .select({ problem_id: trainingProblems.problem_id })
    .from(trainingProblems)
    .where(eq(trainingProblems.training_id, trainingId));
  const existingIds = new Set(existing.map((r) => r.problem_id));
  if (
    problemsInput.some((r) =>
      typeof r.problem_id !== "string" || !r.problem_id.trim() ||
      !Number.isInteger(r.position)
    )
  ) {
    throw new BadRequestError(
      "problem_id 必须为非空字符串，position 必须为整数",
    );
  }
  const inputIds = new Set(problemsInput.map((r) => r.problem_id));
  if (inputIds.size !== problemsInput.length) {
    throw new BadRequestError("problem_id 不能重复");
  }
  if (
    existingIds.size !== inputIds.size ||
    [...existingIds].some((id) => !inputIds.has(id))
  ) {
    throw new BadRequestError("重排必须包含题单当前全部题目");
  }
  const positions = new Set(problemsInput.map((r) => r.position));
  if (positions.size !== problemsInput.length) {
    throw new BadRequestError("position 不能重复");
  }
  if (problemsInput.some((r) => r.position < 0)) {
    throw new BadRequestError("position 不能为负数");
  }

  await db.transaction(async (tx) => {
    await tx.delete(trainingProblems).where(
      eq(trainingProblems.training_id, trainingId),
    );
    await tx.insert(trainingProblems).values(
      problemsInput.map((r) => ({
        training_id: trainingId,
        problem_id: r.problem_id,
        position: r.position,
      })),
    );
  });
  return listTrainingProblems(trainingId, actorId, isAdmin);
}

/**
 * 从题单移除指定题目。
 *
 * @param trainingId 题单内部 UUID
 * @param problemId 题目内部 UUID
 * @param actorId 操作者用户 id
 * @param isAdmin 操作者是否为管理员
 * @throws {NotFoundError} 题单不存在
 * @throws {ForbiddenError} 无权编辑该题单
 */
export async function removeTrainingProblem(
  trainingId: string,
  problemId: string,
  actorId: string,
  isAdmin = false,
): Promise<void> {
  await assertWritable(trainingId, actorId, isAdmin);
  const db = getDb();
  await db.delete(trainingProblems).where(and(
    eq(trainingProblems.training_id, trainingId),
    eq(trainingProblems.problem_id, problemId),
  ));
}
