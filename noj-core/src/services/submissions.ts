import {
  and,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../db/schema.ts";
import { AppError, BadRequestError, NotFoundError } from "../lib/errors.ts";
import { getDb } from "../db/connection.ts";
import { pushJudgeTask } from "../mq/producer.ts";
import { getProblem } from "./problems.ts";
import { validateJudgeImageWithKind } from "./judge-images.ts";
import { getStorageProvider } from "../lib/storage/mod.ts";
import { getPendingSubmissionIds, getSubmissionQueueStatus } from "./queue.ts";
import type {
  JudgeResult,
  JudgeTask,
  SubmissionStatus,
} from "../types/index.ts";
import { logAudit } from "./audit-log.ts";
import { LANGUAGE_EXT_MAP } from "../types/index.ts";
import type { RuntimeConfig } from "../types/problems.ts";
import { Channels, publishEvent } from "../lib/event-bus.ts";
import { applyNewResult } from "./stats-cache.ts";
export interface SubmissionInput {
  problem_id: string;
  language: string;
  code: string;
  file_name?: string;
}

export interface SubmissionResponse {
  id: string;
  user_id: string;
  problem_id: string;
  language: string;
  code: string;
  file_name: string | null;
  status: SubmissionStatus;
  created_at: string;
}

/**
 * 提交详情响应——基础数据公开，详细内容（code/output/details）按权限裁剪。
 *
 * - viewer 是 owner 或 admin → `code`/`output`/`details` 完整返回（output 可能被截断）
 * - viewer 是匿名用户或登录非 owner → `code`/`output`/`details` 均为 null
 */
export interface SubmissionDetail {
  id: string;
  user_id: string;
  problem_id: string;
  language: string;
  /** 源代码：仅 owner/admin 可见，否则为 null */
  code: string | null;
  file_name: string | null;
  status: SubmissionStatus;
  created_at: string;
  result: {
    status: string;
    score: number;
    /** 评测脚本输出：仅 owner/admin 可见（可能被截断至 8KB），否则为 null */
    output: string | null;
    /** output 是否被 API 层截断（issue 64 评论 §5.1）；非 owner/admin 为 null */
    output_truncated: boolean | null;
    time_ms: number | null;
    memory_kb: number | null;
    /** 评测用例级详情：仅 owner/admin 可见，否则为 null */
    details: Record<string, unknown> | null;
  } | null;
  /** 排队位置（1-based），仅在 pending/等待中时有值。 */
  queue_position?: number | null;
  /** 当前 pending 队列总长度。 */
  queue_length?: number | null;
  /** 开始评测时间。 */
  judge_started_at?: string | null;
  /** 评测完成时间。 */
  judge_finished_at?: string | null;
}

/**
 * @deprecated 请使用 `SubmissionDetail`——本接口保留仅为兼容旧调用方。
 */
export interface SubmissionWithResult extends SubmissionDetail {}

/**
 * 提交列表项——不含 code 字段，附带题目和评测摘要。
 */
export interface SubmissionListItem {
  id: string;
  user_id: string;
  problem_id: string;
  language: string;
  file_name: string | null;
  status: SubmissionStatus;
  created_at: string;
  judge_started_at: string | null;
  judge_finished_at: string | null;
  queue_position: number | null;
  queue_length: number | null;
  problem: {
    id: string;
    title: string;
  };
  result: {
    status: string;
    score: number;
    time_ms: number | null;
    memory_kb: number | null;
  } | null;
}

/**
 * 列表查询参数。
 */
export interface ListSubmissionsParams {
  userId?: string;
  problemId?: string;
  problemSearch?: string;
  submissionId?: string;
  userSearch?: string;
  language?: string;
  status?: string;
  from?: string;
  to?: string;
  page: number;
  perPage: number;
}

/**
 * 列表查询结果。
 */
export interface ListSubmissionsResult {
  data: SubmissionListItem[];
  total: number;
}

/**
 * 查询提交列表（分页 + 筛选）。
 *
 * 使用 LEFT JOIN 一次获取提交、题目、评测结果，避免 N+1。
 * 不返回 code 字段（源代码仅在详情接口返回）。
 */
export async function listSubmissions(
  params: ListSubmissionsParams,
): Promise<ListSubmissionsResult> {
  const db = getDb();
  const {
    userId,
    problemId,
    problemSearch,
    submissionId,
    userSearch,
    language,
    status,
    from,
    to,
    page,
    perPage,
  } = params;

  // 动态构建筛选条件（仅对提供的参数添加条件）
  const conditions: ReturnType<typeof eq>[] = [];

  if (userId) conditions.push(eq(submissions.user_id, userId));
  if (problemId) conditions.push(eq(submissions.problem_id, problemId));
  if (language) conditions.push(eq(submissions.language, language));
  if (status) {
    conditions.push(eq(submissions.status, status as SubmissionStatus));
  }
  if (from) conditions.push(gte(submissions.created_at, from));
  if (to) conditions.push(lte(submissions.created_at, to));

  // problemSearch: problem_id 精确匹配 OR problems.title ILIKE 模糊搜索
  if (problemSearch) {
    conditions.push(
      or(
        eq(submissions.problem_id, problemSearch),
        ilike(problems.title, `%${problemSearch}%`),
      ) as unknown as ReturnType<typeof eq>,
    );
  }

  // submissionId: submissions.id ILIKE 前缀匹配
  if (submissionId) {
    conditions.push(
      ilike(submissions.id, `${submissionId}%`) as unknown as ReturnType<
        typeof eq
      >,
    );
  }

  // userSearch: users.username ILIKE OR submissions.user_id 前缀匹配
  if (userSearch) {
    conditions.push(
      or(
        ilike(users.username, `%${userSearch}%`),
        ilike(submissions.user_id, `${userSearch}%`),
      ) as unknown as ReturnType<typeof eq>,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // COUNT 总数（需 LEFT JOIN problems 以支持 problemSearch，users 以支持 userSearch）
  let countQuery = db
    .select({ total: sql<number>`count(*)` })
    .from(submissions)
    .leftJoin(problems, eq(submissions.problem_id, problems.id));
  // userSearch 需要关联 users 表
  if (userSearch) {
    countQuery = countQuery.leftJoin(users, eq(submissions.user_id, users.id));
  }
  const [countRow] = await countQuery.where(where);

  const total = Number(countRow?.total ?? 0);

  // 无数据时提前返回，避免无效查询
  if (total === 0) {
    return { data: [], total: 0 };
  }

  const offset = (page - 1) * perPage;

  // 数据查询：LEFT JOIN problems + evaluation_results（+ users 当需要 userSearch 时）
  let dataQuery = db
    .select({
      id: submissions.id,
      user_id: submissions.user_id,
      problem_id: submissions.problem_id,
      language: submissions.language,
      file_name: submissions.file_name,
      status: submissions.status,
      created_at: submissions.created_at,
      judge_started_at: submissions.judge_started_at,
      judge_finished_at: submissions.judge_finished_at,
      problem_title: problems.title,
      result_status: evaluationResults.status,
      result_score: evaluationResults.score,
      result_time_ms: evaluationResults.time_ms,
      result_memory_kb: evaluationResults.memory_kb,
    })
    .from(submissions)
    .leftJoin(problems, eq(submissions.problem_id, problems.id))
    .leftJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    );
  if (userSearch) {
    dataQuery = dataQuery.leftJoin(
      users,
      eq(submissions.user_id, users.id),
    );
  }
  const rows = await dataQuery.where(where)
    .orderBy(sql`${submissions.created_at} DESC`)
    .offset(offset)
    .limit(perPage);

  // 仅当存在无结果的 in-progress 提交时才查 Redis 队列
  // （避免每次列表请求都 LRANGE 整个队列）
  const hasInProgress = rows.some((r) => !r.result_status);
  let pendingPosMap: Map<string, number> | null = null;
  let queueLength: number | null = null;
  if (hasInProgress) {
    try {
      const pendingIds = await getPendingSubmissionIds();
      queueLength = pendingIds.length;
      // LRANGE 0 -1 返回最新优先（LPUSH），pendingIds.length - idx
      // 使队列位置从 1（下个出队）递增
      pendingPosMap = new Map(
        pendingIds.map((id, idx) => [id, pendingIds.length - idx]),
      );
    } catch {
      // Redis 不可用时，pendingPosMap 保持 null，所有未完成提交视为"评测中"
    }
  }

  const data: SubmissionListItem[] = rows.map((row) => {
    const hasResult = !!row.result_status;
    const queue_position = !hasResult && pendingPosMap
      ? (pendingPosMap.get(row.id) ?? null)
      : null;
    return {
      id: row.id,
      user_id: row.user_id,
      problem_id: row.problem_id,
      language: row.language,
      file_name: row.file_name,
      status: row.status,
      created_at: row.created_at,
      judge_started_at: row.judge_started_at ?? null,
      judge_finished_at: row.judge_finished_at ?? null,
      queue_position,
      queue_length: !hasResult ? queueLength : null,
      problem: {
        id: row.problem_id,
        title: row.problem_title ?? "",
      },
      result: row.result_status
        ? {
          status: row.result_status,
          score: row.result_score ?? 0,
          time_ms: row.result_time_ms,
          memory_kb: row.result_memory_kb,
        }
        : null,
    };
  });

  return { data, total };
}

/**
 * 将数据库行转换为提交响应。
 */
function _toSubmissionResponse(
  row: typeof submissions.$inferSelect,
): SubmissionResponse {
  return {
    id: row.id,
    user_id: row.user_id,
    problem_id: row.problem_id,
    language: row.language,
    code: row.code,
    file_name: row.file_name,
    status: row.status,
    created_at: row.created_at,
  };
}

/**
 * 创建提交记录并推送到评测队列。
 *
 * @throws {NotFoundError} 题目不存在
 */
export async function createSubmission(
  userId: string,
  input: SubmissionInput,
): Promise<SubmissionResponse> {
  const db = getDb();

  // 行级锁 + 读取最新题目配置（避免 admin 在提交期间清空 runtime_config 导致竞态）
  const lockedRows = await db
    .select()
    .from(problems)
    .where(eq(problems.id, input.problem_id))
    .for("update")
    .limit(1);
  if (lockedRows.length === 0) {
    throw new NotFoundError("题目不存在");
  }
  const problem = lockedRows[0];

  // 验证语言
  const supportedLanguages = ["python3", "python", "cpp", "c", "javascript"];
  if (!supportedLanguages.includes(input.language)) {
    throw new BadRequestError(`不支持的语言: ${input.language}`);
  }

  // 生成文件默认名：优先使用 LANGUAGE_EXT_MAP
  const fileName = input.file_name || LANGUAGE_EXT_MAP[input.language] ||
    "main.txt";

  // 创建提交记录并推送到评测队列（在同一个 try 块中保证一致性）
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // 获取支持包 download URL
  let download_url: string | undefined;
  if (problem.support_package_storage_url) {
    try {
      const storage = await getStorageProvider();
      download_url = await storage.downloadUrl(
        problem.support_package_storage_url,
      );
    } catch (err) {
      console.error(
        `获取支持包 download URL 失败 (${problem.support_package_storage_url}):`,
        err instanceof Error ? err.message : String(err),
      );
      // 支持包获取失败不阻塞提交，但会跳过支持包
    }
  }

  // ── 使用 runtime_config（双容器模式）──
  // 校验 evaluator/solution image + kind（spec §4 final gate）
  const runtimeConfig = problem.runtime_config as
    | import("../types/problems.ts").RuntimeConfig
    | null
    | undefined;

  if (!runtimeConfig) {
    throw new AppError(
      "题目缺少 runtime_config 配置，无法评测",
      500,
      "RUNTIME_CONFIG_MISSING",
    );
  }

  // 防御性 final gate：校验双容器镜像 + kind
  await validateJudgeImageWithKind(
    runtimeConfig.evaluator.image,
    "evaluator",
  );
  await validateJudgeImageWithKind(
    runtimeConfig.solution.image,
    "solution",
  );

  const task: JudgeTask = {
    submission_id: id,
    problem_id: input.problem_id,
    runtime_config: runtimeConfig as NonNullable<typeof runtimeConfig>,
    download_url,
    language: input.language,
    code: input.code,
    file_name: fileName,
  };

  try {
    await db.insert(submissions).values({
      id,
      user_id: userId,
      problem_id: input.problem_id,
      language: input.language,
      code: input.code,
      file_name: fileName,
      status: "pending",
      created_at: now,
    });
  } catch (dbErr) {
    console.error("提交记录插入失败:", dbErr);
    throw new AppError(
      "提交失败：数据库写入错误，请稍后重试",
      500,
      "SUBMISSION_DB_ERROR",
    );
  }

  try {
    await pushJudgeTask(task);
    // 入队成功后立即更新状态为 judging
    // 注意：此处不设置 judge_started_at，它由 noj-judge 开始执行时通过 started 事件设置
    await db.update(submissions).set({ status: "judging" }).where(
      eq(submissions.id, id),
    );

    // 发布队列变更事件，通知 SSE 等订阅者
    publishEvent(Channels.queue, JSON.stringify({ type: "queue:changed" }));
  } catch (mqErr) {
    console.error("评测任务推送失败:", mqErr);
    // DB 成功但 MQ 失败，标记为 error 让用户重新提交
    try {
      await updateSubmissionStatus(id, "error");
    } catch {
      // 忽略 cleanup 失败
    }
    throw new AppError(
      "提交失败：评测队列暂时不可用，请稍后重试",
      500,
      "SUBMISSION_QUEUE_ERROR",
    );
  }

  return {
    id,
    user_id: userId,
    problem_id: input.problem_id,
    language: input.language,
    code: input.code,
    file_name: fileName,
    status: "judging",
    created_at: now,
  };
}

/**
 * 详情接口返回的 result.output 最大长度（字节近似）。
 *
 * 评测脚本 stdout 可能包含大量测试点详情，单次响应过大影响
 * 移动端加载与序列化性能。原始 output 仍完整保存在 DB 中，
 * 本截断仅作用于 API 响应层。
 *
 * 修复 issue 64 评论 §5.1。
 */
const MAX_OUTPUT_LENGTH = 8 * 1024;

/**
 * 根据 ID 查询提交记录。
 *
 * 权限模型（issue: 评测详情公开访问分级）：
 * - 基础数据（题号、状态、时间、内存、得分等）：所有访问者可见
 * - 详细内容（源代码、评测输出、用例级详情）：仅 owner 或 admin 可见
 *
 * @param id 提交 ID
 * @param viewerId 当前查看者的 userId；undefined/null 表示匿名访问
 * @param viewerRole 当前查看者的角色；'admin' 时跳过所有权校验
 *
 * @throws {NotFoundError} 提交不存在
 */
export async function getSubmission(
  id: string,
  viewerId?: string | null,
  viewerRole?: string | null,
): Promise<SubmissionDetail> {
  const db = getDb();

  const rows = await db
    .select()
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  if (rows.length === 0) {
    throw new NotFoundError("提交不存在");
  }

  const row = rows[0];

  // 权限判断：仅 owner 或 admin 可看 code/output/details
  // 注意：基础数据（题号/状态/时间等）对所有访问者公开，不在这里做"非所有者 404"的拦截
  const isOwner = !!viewerId && row.user_id === viewerId;
  const isAdmin = viewerRole === "admin";
  const canSeeDetails = isOwner || isAdmin;

  // 查询评测结果
  const resultRows = await db
    .select()
    .from(evaluationResults)
    .where(eq(evaluationResults.submission_id, id))
    .limit(1);

  const result = resultRows.length > 0
    ? (() => {
      const rawOutput = resultRows[0].output ?? "";
      // API 层截断：原始 output 完整保留在 DB，仅响应层控制大小
      const output_truncated = rawOutput.length > MAX_OUTPUT_LENGTH;
      // 仅 owner/admin 返回 output（截断），其他访问者得到 null
      const output = canSeeDetails
        ? (output_truncated ? rawOutput.slice(0, MAX_OUTPUT_LENGTH) : rawOutput)
        : null;
      // 仅 owner/admin 解析 details JSON，其他访问者得到 null
      const details = canSeeDetails
        ? parseDetails(resultRows[0].details)
        : null;
      return {
        status: resultRows[0].status,
        score: resultRows[0].score,
        output,
        output_truncated: canSeeDetails ? output_truncated : null,
        time_ms: resultRows[0].time_ms,
        memory_kb: resultRows[0].memory_kb,
        details,
      };
    })()
    : null;

  // 查询队列状态信息（排队位置、时间戳）
  // getSubmissionQueueStatus 已实现三态权限：未登录 + owner + admin 可见，登录非 owner 不可见
  // Redis 不可用时内部静默失败，返回 null 时间戳回退至 DB 值
  const queueStatus = await getSubmissionQueueStatus(
    id,
    viewerId ?? undefined,
    viewerRole ?? undefined,
  );

  return {
    id: row.id,
    user_id: row.user_id,
    problem_id: row.problem_id,
    language: row.language,
    code: canSeeDetails ? row.code : null,
    file_name: row.file_name,
    status: row.status,
    created_at: row.created_at,
    result,
    queue_position: queueStatus?.queue_position ?? null,
    queue_length: queueStatus?.queue_length ?? null,
    judge_started_at: queueStatus?.judge_started_at ?? row.judge_started_at ??
      null,
    judge_finished_at: queueStatus?.judge_finished_at ??
      row.judge_finished_at ?? null,
  };
}

/**
 * 保存评测结果。
 *
 * 由结果消费者调用，将 noj-judge 返回的 JudgeResult 持久化到数据库。
 * 原子操作：更新 submission 状态 → INSERT evaluation_results。
 */
export async function saveEvaluationResult(
  result: JudgeResult,
): Promise<void> {
  const db = getDb();

  const incomingSeq = result.rejudge_seq ?? 0;
  const [sub] = await db
    .select({
      rejudge_seq: submissions.rejudge_seq,
      created_at: submissions.created_at,
    })
    .from(submissions)
    .where(eq(submissions.id, result.submission_id))
    .limit(1);

  if (!sub) {
    console.warn(
      `提交不存在，忽略评测结果: submission=${result.submission_id}`,
    );
    return;
  }

  if (incomingSeq < sub.rejudge_seq) {
    console.warn(
      `忽略过时的评测结果: submission=${result.submission_id}, ` +
        `result_seq=${incomingSeq}, current_seq=${sub.rejudge_seq}`,
    );
    return;
  }

  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    const submissionStatus: SubmissionStatus = result.status === "SystemError"
      ? "error"
      : "finished";

    await tx
      .update(submissions)
      .set({
        status: submissionStatus,
        judge_finished_at: now,
      })
      .where(eq(submissions.id, result.submission_id));

    await tx
      .insert(evaluationResults)
      .values({
        id: crypto.randomUUID(),
        submission_id: result.submission_id,
        status: result.status,
        score: result.score,
        output: result.output,
        details: JSON.stringify(result.details),
        time_ms: result.time_ms ?? null,
        memory_kb: result.memory_kb ?? null,
        created_at: now,
      })
      .onConflictDoUpdate({
        target: evaluationResults.submission_id,
        set: {
          status: result.status,
          score: result.score,
          output: result.output,
          details: JSON.stringify(result.details),
          time_ms: result.time_ms ?? null,
          memory_kb: result.memory_kb ?? null,
          created_at: now,
        },
      });
  });

  // 更新内存统计缓存（仅 net-new 结果，重测不计入避免 double-count）
  if (sub.created_at) {
    applyNewResult(result.score, sub.created_at);
  }
}

// 允许的状态转换
const VALID_TRANSITIONS: Record<SubmissionStatus, SubmissionStatus[]> = {
  pending: ["judging", "error"],
  judging: ["finished", "error"],
  finished: [],
  error: [],
};

/**
 * 解析 details 字段。
 * 数据库中以 JSON 字符串存储，解析为对象返回。
 */
function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 更新提交状态。
 * 校验状态转换是否合法（pending → judging → finished）。
 * 同步更新 judge_started_at / judge_finished_at 时间戳。
 *
 * @throws {NotFoundError} 提交不存在
 * @throws {BadRequestError} 状态转换非法
 */
export async function updateSubmissionStatus(
  id: string,
  status: SubmissionStatus,
): Promise<void> {
  const db = getDb();

  const existing = await db
    .select({ status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("提交不存在");
  }

  const current = existing[0].status as SubmissionStatus;
  if (!VALID_TRANSITIONS[current]?.includes(status)) {
    throw new BadRequestError(`无效的状态转换: ${current} → ${status}`);
  }

  const now = new Date().toISOString();
  const updates: Record<string, string | undefined> = { status };

  // 设置 judge_started_at：pending → judging
  if (status === "judging") {
    updates.judge_started_at = now;
  }

  // 设置 judge_finished_at：judging → finished / error
  if (status === "finished" || status === "error") {
    updates.judge_finished_at = now;
  }

  await db
    .update(submissions)
    .set(updates)
    .where(eq(submissions.id, id));
}

/**
 * 今日提交统计。
 */
export interface TodayStats {
  total: number;
  full_score: number;
  not_full_score: number;
}

/**
 * 获取当前用户的今日提交统计。
 * - total：今日提交总数
 * - full_score：今日获得满分的提交数（score >= 10000）
 * - not_full_score：今日未获满分的提交数
 */
/**
 * 获取全站历史累计提交统计（不受时间范围限制）。
 */
export async function getTotalStats(): Promise<TodayStats> {
  const db = getDb();

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      full_score: sql<
        number
      >`count(*) filter (where ${evaluationResults.score} >= 10000)::int`,
    })
    .from(submissions)
    .leftJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    );

  const total = Number(row?.total ?? 0);
  const fullScore = Number(row?.full_score ?? 0);
  const notFullScore = total - fullScore;

  return {
    total,
    full_score: fullScore,
    not_full_score: notFullScore,
  };
}

export async function getTodayStats(userId?: string): Promise<TodayStats> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const conditions: SQL[] = [gte(submissions.created_at, today)];
  if (userId) conditions.push(eq(submissions.user_id, userId));

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      full_score: sql<
        number
      >`count(*) filter (where ${evaluationResults.score} >= 10000)::int`,
    })
    .from(submissions)
    .leftJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    )
    .where(and(...conditions));

  const total = Number(row?.total ?? 0);
  const fullScore = Number(row?.full_score ?? 0);
  const notFullScore = total - fullScore;

  return {
    total,
    full_score: fullScore,
    not_full_score: notFullScore,
  };
}

const MAX_BATCH_REJUDGE = 500;

type BatchTxResult = {
  ids: string[];
  count: number;
  rows?: {
    id: string;
    language: string;
    code: string;
    file_name: string | null;
  }[];
} | { error: string };

export async function rejudgeSubmission(id: string): Promise<void> {
  const db = getDb();

  const [submission] = await db
    .select()
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  if (!submission) {
    throw new NotFoundError("提交不存在");
  }

  const problem = await getProblem(submission.problem_id);

  // 获取支持包 download URL
  let download_url: string | undefined;
  try {
    if (problem.support_package_storage_url) {
      const storage = await getStorageProvider();
      download_url = await storage.downloadUrl(
        problem.support_package_storage_url,
      );
    }
  } catch (err) {
    console.error(
      `重测获取支持包 download URL 失败 (${problem.support_package_storage_url}):`,
      err instanceof Error ? err.message : String(err),
    );
  }

  await db.transaction(async (tx) => {
    await tx.delete(evaluationResults)
      .where(eq(evaluationResults.submission_id, id));

    await tx.update(submissions)
      .set({
        status: "pending",
        judge_started_at: null,
        judge_finished_at: null,
        rejudge_seq: sql`${submissions.rejudge_seq} + 1`,
      })
      .where(eq(submissions.id, id));
  });

  const [updated] = await db
    .select({ rejudge_seq: submissions.rejudge_seq })
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  await updateSubmissionStatus(id, "judging");

  const runtimeConfig = problem.runtime_config as
    | import("../types/problems.ts").RuntimeConfig
    | null
    | undefined;

  const task: JudgeTask = {
    submission_id: id,
    problem_id: submission.problem_id,
    runtime_config: runtimeConfig as NonNullable<typeof runtimeConfig>,
    download_url,
    language: submission.language,
    code: submission.code,
    file_name: submission.file_name ??
      (LANGUAGE_EXT_MAP[submission.language] || "main.txt"),
    rejudge_seq: updated?.rejudge_seq ?? 0,
  };

  // 审计日志：先写入审计再推送不可逆的 MQ 消息（issue #101）
  await logAudit(
    "submissions.rejudge",
    {
      action: "submissions.rejudge",
      submission_id: id,
    },
    { type: "submission", id },
  );

  try {
    await pushJudgeTask(task);
  } catch (mqErr) {
    console.error("重测任务推送失败:", mqErr);
    try {
      await updateSubmissionStatus(id, "error");
    } catch {
      // ignore cleanup failure
    }
    throw new AppError(
      "重测失败：评测队列暂时不可用，请稍后重试",
      500,
      "REJUDGE_QUEUE_ERROR",
    );
  }

  publishEvent(Channels.queue, JSON.stringify({ type: "queue:changed" }));
}

export async function rejudgeProblemSubmissions(
  problemId: string,
): Promise<{ total: number; queued: number; skipped: number }> {
  const db = getDb();

  const problem = await getProblem(problemId);

  // 获取支持包 download URL（该题所有提交共享同一份）
  let download_url: string | undefined;
  try {
    if (problem.support_package_storage_url) {
      const storage = await getStorageProvider();
      download_url = await storage.downloadUrl(
        problem.support_package_storage_url,
      );
    }
  } catch (err) {
    console.error(
      `批量重测获取支持包 download URL 失败 (${problem.support_package_storage_url}):`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const txResult = await db.transaction<BatchTxResult>(async (tx) => {
    const activeCounts = await tx
      .select({ status: submissions.status, count: sql<number>`count(*)` })
      .from(submissions)
      .where(
        and(
          eq(submissions.problem_id, problemId),
          inArray(submissions.status, ["pending", "judging"]),
        ),
      )
      .groupBy(submissions.status);

    if (activeCounts.length > 0) {
      const details = activeCounts
        .map((r) => `${r.status}: ${r.count}条`)
        .join("、");
      return {
        error:
          `该题目尚有活跃评测中的提交（${details}），无法批量重测，请等待完成后再试`,
      };
    }

    const rows = await tx
      .select({
        id: submissions.id,
        language: submissions.language,
        code: submissions.code,
        file_name: submissions.file_name,
      })
      .from(submissions)
      .where(
        and(
          eq(submissions.problem_id, problemId),
          inArray(submissions.status, ["finished", "error"]),
        ),
      );

    if (rows.length === 0) {
      return { ids: [], count: 0 };
    }

    if (rows.length > MAX_BATCH_REJUDGE) {
      return {
        error:
          `批量重测超过上限（${rows.length} > ${MAX_BATCH_REJUDGE}），请分批操作`,
      };
    }

    const ids = rows.map((r) => r.id);

    await tx.delete(evaluationResults)
      .where(inArray(evaluationResults.submission_id, ids));

    await tx.update(submissions)
      .set({
        status: "pending",
        judge_started_at: null,
        judge_finished_at: null,
        rejudge_seq: sql`${submissions.rejudge_seq} + 1`,
      })
      .where(inArray(submissions.id, ids));

    return { ids, count: ids.length, rows };
  });

  if ("error" in txResult) {
    throw new BadRequestError(txResult.error);
  }

  const { ids: allIds, count: total } = txResult;

  if (total === 0) {
    return { total: 0, queued: 0, skipped: 0 };
  }

  const [seqRow] = await db
    .select({ rejudge_seq: submissions.rejudge_seq })
    .from(submissions)
    .where(eq(submissions.id, allIds[0]))
    .limit(1);
  const currentSeq = seqRow?.rejudge_seq ?? 0;

  const rejudgeRows = await db
    .select()
    .from(submissions)
    .where(inArray(submissions.id, allIds));

  // 审计日志：先写入审计再推送不可逆的 MQ 消息
  if (total > 0) {
    await logAudit(
      "submissions.rejudge",
      {
        action: "submissions.rejudge",
        problem_id: problemId,
        count: total,
      },
      { type: "problem", id: problemId },
    );
  }

  // 逐条入队（每条代码内容不同，无法合并）
  let queued = 0;
  for (const sub of rejudgeRows) {
    try {
      const task: JudgeTask = {
        submission_id: sub.id,
        problem_id: problemId,
        runtime_config: problem.runtime_config as RuntimeConfig,
        download_url,
        language: sub.language,
        code: sub.code,
        file_name: sub.file_name ??
          (LANGUAGE_EXT_MAP[sub.language] || "main.txt"),
        rejudge_seq: currentSeq,
      };

      await pushJudgeTask(task);
      await updateSubmissionStatus(sub.id, "judging");
      queued++;
    } catch (err) {
      console.error(
        `批量重测入队失败 (submission=${sub.id}):`,
        err instanceof Error ? err.message : String(err),
      );
      // 入队失败：将状态回退到 error，避免卡在 pending 导致无法重试
      try {
        const errNow = new Date().toISOString();
        await db.update(submissions)
          .set({
            status: "error",
            judge_started_at: null,
            judge_finished_at: errNow,
          })
          .where(eq(submissions.id, sub.id));
      } catch { /* ignore cleanup failure */ }
    }
  }

  publishEvent(Channels.queue, JSON.stringify({ type: "queue:changed" }));

  return {
    total,
    queued,
    skipped: total - queued,
  };
}

export async function deleteSubmission(id: string): Promise<void> {
  const db = getDb();

  const existing = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("提交不存在");
  }

  await db.delete(submissions).where(eq(submissions.id, id));
}
