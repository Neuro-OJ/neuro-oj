/**
 * 提交路由的模式分派解析器。
 *
 * multipart 请求体在题目加载之前就已被解析（busboy 流式解析），路由需要先知道
 * 目标题目的 `submission_mode` 才能决定调用 artifact 还是 prediction 服务。
 * 服务层随后会自行加行级锁并重新校验模式与访问规则，因此这里只做**只读**的
 * 轻量模式读取，不承担鉴权职责。
 *
 * 只选取 `submission_mode` 一列，避免把整行题目（含 runtime_config 等大字段）
 * 查出来；与 `createArtifactSubmission` / `createPredictionSubmission` 内部
 * 的行级锁查询相比，这是一次额外的 dispatch 查询，属可接受成本。
 *
 * @module
 */

import { eq } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import { problems } from "./../../../../shared/db/schema.ts";
import { NotFoundError } from "./../../../../shared/base/errors.ts";
import type { JudgeSubmissionMode } from "../../types/index.ts";

/**
 * 解析题目的提交模式（仅供路由分派）。
 *
 * @param problemId 题目 ID
 * @returns `code` / `artifact` / `prediction`
 * @throws {NotFoundError} 题目不存在
 */
export async function resolveProblemSubmissionMode(
  problemId: string,
): Promise<JudgeSubmissionMode> {
  const db = getDb();
  const [row] = await db
    .select({ submission_mode: problems.submission_mode })
    .from(problems)
    .where(eq(problems.id, problemId))
    .limit(1);
  if (!row) {
    throw new NotFoundError("题目不存在");
  }
  return (row.submission_mode as JudgeSubmissionMode) ?? "code";
}
