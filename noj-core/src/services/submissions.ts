import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { evaluationResults, submissions } from "../db/schema.ts";
import { BadRequestError, NotFoundError } from "../lib/errors.ts";
import { pushJudgeTask } from "../mq/producer.ts";
import type { JudgeTask, SubmissionStatus } from "../types/index.ts";

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
  result?: {
    status: string;
    score: number;
    output: string;
    time_ms: number | null;
    memory_kb: number | null;
  } | null;
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
  const { getProblem } = await import("./problems.ts");
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

  // 创建提交记录
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

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

  // 推送到评测队列
  const task: JudgeTask = {
    submission_id: id,
    problem_id: input.problem_id,
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/code.py",
    language: input.language,
    code: input.code,
    file_name: fileName,
    time_limit_ms: problem.time_limit_ms,
    memory_limit_mb: problem.memory_limit_mb,
  };

  try {
    await pushJudgeTask(task);
  } catch (err) {
    console.error("推送评测任务失败:", err);
    // 不阻塞提交创建，评测任务可由补偿 job 重试
  }

  return {
    id,
    user_id: userId,
    problem_id: input.problem_id,
    language: input.language,
    code: input.code,
    file_name: fileName,
    status: "pending",
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
 * 更新提交状态。
 */
export async function updateSubmissionStatus(
  id: string,
  status: SubmissionStatus,
): Promise<void> {
  const db = getDb();

  await db
    .update(submissions)
    .set({ status })
    .where(eq(submissions.id, id));
}
