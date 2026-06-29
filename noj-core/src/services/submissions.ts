import { encodeBase64 } from "@std/encoding/base64";
import { and, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../db/schema.ts";
import { AppError, BadRequestError, NotFoundError } from "../lib/errors.ts";
import { pushJudgeTask } from "../mq/producer.ts";
import { Channels, publishEvent } from "../lib/event-bus.ts";
import { getProblem } from "./problems.ts";
import type {
  JudgeResult,
  JudgeTask,
  SubmissionStatus,
} from "../types/index.ts";
import { getSubmissionQueueStatus } from "./queue.ts";

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

export interface SubmissionWithResult extends SubmissionResponse {
  result: {
    status: string;
    score: number;
    output: string;
    /** output 是否被 API 层截断（issue 64 评论 §5.1） */
    output_truncated: boolean;
    time_ms: number | null;
    memory_kb: number | null;
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

  const data: SubmissionListItem[] = rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    problem_id: row.problem_id,
    language: row.language,
    file_name: row.file_name,
    status: row.status,
    created_at: row.created_at,
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
  }));

  return { data, total };
}

/**
 * 将数据库行转换为提交响应。
 */
function toSubmissionResponse(
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

  // 检查题目是否存在并获取信息
  const problem = await getProblem(input.problem_id);

  // 验证语言
  const supportedLanguages = ["python3", "python", "cpp", "c", "javascript"];
  if (!supportedLanguages.includes(input.language)) {
    throw new BadRequestError(`不支持的语言: ${input.language}`);
  }

  // 生成文件默认名
  const extMap: Record<string, string> = {
    python3: "main.py",
    python: "main.py",
    cpp: "main.cpp",
    c: "main.c",
    javascript: "main.js",
  };
  const fileName = input.file_name || extMap[input.language] || "main.txt";

  // 创建提交记录并推送到评测队列（在同一个 try 块中保证一致性）
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // 读取支持包并 Base64 编码
  let support_package_base64: string | undefined;
  if (problem.support_package_path) {
    try {
      const zipBytes = await Deno.readFile(problem.support_package_path);
      support_package_base64 = encodeBase64(zipBytes);
    } catch (err) {
      console.error(
        `读取支持包失败 (${problem.support_package_path}):`,
        err instanceof Error ? err.message : String(err),
      );
      // 支持包读取失败不阻塞提交，但会跳过支持包
    }
  }

  const task: JudgeTask = {
    submission_id: id,
    problem_id: input.problem_id,
    judge_image: problem.judge_image,
    judge_command: problem.judge_command,
    support_package_base64,
    language: input.language,
    code: input.code,
    file_name: fileName,
    time_limit_ms: problem.time_limit_ms,
    memory_limit_mb: problem.memory_limit_mb,
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
    await updateSubmissionStatus(id, "judging");

    // 发布队列变更事件（fire-and-forget）
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
 * userId 若为空字符串或 undefined，则跳过所有权检查（供测试或内部调用）。
 *
 * @throws {NotFoundError} 提交不存在
 */
export async function getSubmission(
  id: string,
  userId?: string,
): Promise<SubmissionWithResult> {
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

  // 非所有者只能查看自己的提交
  if (userId && row.user_id !== userId) {
    throw new NotFoundError("提交不存在");
  }

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
      const output = output_truncated
        ? rawOutput.slice(0, MAX_OUTPUT_LENGTH)
        : rawOutput;
      return {
        status: resultRows[0].status,
        score: resultRows[0].score,
        output,
        output_truncated,
        time_ms: resultRows[0].time_ms,
        memory_kb: resultRows[0].memory_kb,
        details: parseDetails(resultRows[0].details),
      };
    })()
    : null;

  // 查询队列状态信息（排队位置、时间戳）
  // getSubmission 已在上面完成归属校验，此处仍传 userId 让服务层做兜底校验
  const queueStatus = await getSubmissionQueueStatus(id, userId);

  return {
    ...toSubmissionResponse(row),
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

  const now = new Date().toISOString();

  // 使用事务保证原子性：更新 submission 状态 + 插入 evaluation_results
  await db.transaction(async (tx) => {
    // 根据评测结果状态映射 submission 状态
    // SystemError → "error"，其他 → "finished"
    const submissionStatus: SubmissionStatus = result.status === "SystemError"
      ? "error"
      : "finished";

    // 同步回填 judge_finished_at 时间戳
    //
    // 修复 issue 64 评论 §4.1：saveEvaluationResult 走的是直接 UPDATE，
    // 绕过了 updateSubmissionStatus 中状态转换时的字段同步逻辑，
    // 导致 judge_finished_at 永远为 NULL，admin 监控与前端历史记录的
    // "完成时间"显示空。
    //
    // 注意：updateSubmissionStatus 也会设置该字段，但状态机校验
    // (pending → judging → finished) 不允许 finished → finished 的二次更新，
    // 因此这里直接在 saveEvaluationResult 中设置以保证准确性。
    await tx
      .update(submissions)
      .set({
        status: submissionStatus,
        judge_finished_at: now,
      })
      .where(eq(submissions.id, result.submission_id));

    // 插入评测结果（使用 UPSERT 语义防止重复消费）
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
      .onConflictDoNothing({ target: evaluationResults.submission_id });
  });
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
  const updates: Record<string, string> = { status };

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
 * 管理员删除提交记录。
 *
 * 硬删除提交记录及关联的评测结果（通过 ON DELETE CASCADE 自动清理）。
 * 仅管理员可通过 admin 端点调用。
 *
 * @throws {NotFoundError} 提交不存在
 */
export async function deleteSubmission(id: string): Promise<void> {
  const db = getDb();

  // 检查提交是否存在
  const existing = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("提交不存在");
  }

  // 硬删除（evaluation_results 通过 ON DELETE CASCADE 自动清理）
  await db.delete(submissions).where(eq(submissions.id, id));
}
