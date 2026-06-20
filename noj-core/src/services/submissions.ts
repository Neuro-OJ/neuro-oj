import { encodeBase64 } from "@std/encoding/base64";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { evaluationResults, problems, submissions } from "../db/schema.ts";
import { AppError, BadRequestError, NotFoundError } from "../lib/errors.ts";
import { pushJudgeTask } from "../mq/producer.ts";
import { getProblem } from "./problems.ts";
import type {
  JudgeResult,
  JudgeTask,
  SubmissionStatus,
} from "../types/index.ts";

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
    time_ms: number | null;
    memory_kb: number | null;
  } | null;
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
  } | null;
}

/**
 * 列表查询参数。
 */
export interface ListSubmissionsParams {
  userId?: string;
  problemId?: string;
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
  const { userId, problemId, language, status, from, to, page, perPage } =
    params;

  // 动态构建筛选条件（仅对提供的参数添加条件）
  const conditions: ReturnType<typeof eq>[] = [];

  if (userId) conditions.push(eq(submissions.user_id, userId));
  if (problemId) conditions.push(eq(submissions.problem_id, problemId));
  if (language) conditions.push(eq(submissions.language, language));
  if (status) conditions.push(eq(submissions.status, status as SubmissionStatus));
  if (from) conditions.push(gte(submissions.created_at, from));
  if (to) conditions.push(lte(submissions.created_at, to));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // COUNT 总数
  const [countRow] = await db
    .select({ total: sql<number>`count(*)` })
    .from(submissions)
    .where(where);

  const total = Number(countRow?.total ?? 0);

  // 无数据时提前返回，避免无效查询
  if (total === 0) {
    return { data: [], total: 0 };
  }

  const offset = (page - 1) * perPage;

  // 数据查询：LEFT JOIN problems + evaluation_results
  const rows = await db
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
    })
    .from(submissions)
    .leftJoin(problems, eq(submissions.problem_id, problems.id))
    .leftJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    )
    .where(where)
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
    await pushJudgeTask(task);
    // 入队成功后立即更新状态为 judging
    await updateSubmissionStatus(id, "judging");
  } catch (err) {
    // 若 DB 插入成功但 MQ 推送失败，标记为 error
    try {
      await updateSubmissionStatus(id, "error");
    } catch {
      // 忽略 cleanup 失败（可能是 DB 插入未完成）
    }
    console.error("创建提交或推送评测任务失败:", err);
    throw new AppError("提交失败，请稍后重试", 500);
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
 * 根据 ID 查询提交记录。
 *
 * @throws {NotFoundError} 提��不存在
 */
export async function getSubmission(
  id: string,
  userId: string,
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
    ? {
      status: resultRows[0].status,
      score: resultRows[0].score,
      output: resultRows[0].output,
      time_ms: resultRows[0].time_ms,
      memory_kb: resultRows[0].memory_kb,
    }
    : null;

  return {
    ...toSubmissionResponse(row),
    result,
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
    // 更新提交状态
    await tx
      .update(submissions)
      .set({ status: "finished" })
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
  judging: ["finished"],
  finished: [],
  error: [],
};

/**
 * 更新提交状态。
 * 校验状态转换是否合法（pending → judging → finished）。
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

  await db
    .update(submissions)
    .set({ status })
    .where(eq(submissions.id, id));
}
