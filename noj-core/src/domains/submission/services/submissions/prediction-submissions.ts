/**
 * prediction 提交服务（预测结果文件提交）。
 *
 * 与 artifact 提交的区别：
 * - 提交物是**单个数据文件**（非 zip），扩展名/魔数经 `validatePredictionFile` 校验；
 * - 评测只创建 Evaluator 容器（`runtime_config` 可省略 `solution`），因此本路径
 *   **不读取也不校验 `solution`**；
 * - 复用 `submissions.artifact_storage_url` 列存放预测文件 URL，从而免费继承既有
 *   「评测后删除 / 不支持重测 / 孤儿清理 / 相似度排除」生命周期。
 *
 * 负责：
 * - 校验题目 submission_mode=prediction
 * - 流式上传单文件到存储（local 临时文件 / S3 multipart）
 * - 双层大小限制（题目 artifact_max_size_mb + NOJ 硬上限）
 * - 创建提交记录并推送评测任务
 * - 评测/入队失败时立即删除上传对象
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import { problems, submissions } from "./../../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "./../../../../shared/base/errors.ts";
import { getStorageProvider } from "./../../../system/index.ts";
import { generatePublicId } from "./../../../../shared/security/public-id.ts";
import {
  isRetryableJudgeQueueError,
  pushJudgeTask,
} from "../../mq/producer.ts";
import { validateJudgeImageWithKind } from "../../../system/index.ts";
import { assertContestSubmissionLimit } from "../../../contest/index.ts";
import { verifyContestAccess } from "../../../contest/index.ts";
import { resolveProblemAccess } from "../../../catalog/index.ts";
import { resolveJudgeTaskPriority } from "./judge-priority.ts";
import {
  Channels,
  publishSseEvent,
} from "./../../../../shared/sse/event-bus.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "submission"]);
import { buildJudgeTask } from "../../types/index.ts";
import type { RuntimeConfig } from "./../../../catalog/index.ts";
import type { SubmissionResponse } from "./submissions-types.ts";
import { getArtifactHardLimit } from "./artifact-submissions.ts";
import { peekFirstChunk } from "./stream-peek.ts";
import {
  predictionFileExtension,
  validatePredictionFile,
} from "./prediction-format.ts";

/** prediction 提交的输入（单文件流）。 */
export interface PredictionSubmissionInput {
  problem_id: string;
  file_name: string;
  file_stream: ReadableStream<Uint8Array>;
  contest_id?: string;
}

/**
 * 创建 prediction 提交。
 *
 * @param userId 提交用户
 * @param input problem_id / file_name / file_stream / contest_id
 * @param contestId 路由层显式竞赛 ID（可选）
 * @param clientIp 客户端 IP（审计用）
 * @param isAdmin 是否管理员（访问解析用）
 */
export async function createPredictionSubmission(
  userId: string,
  input: PredictionSubmissionInput,
  contestId?: string,
  clientIp?: string,
  isAdmin = false,
): Promise<SubmissionResponse> {
  const db = getDb();
  if (contestId && input.contest_id && contestId !== input.contest_id) {
    throw new BadRequestError("竞赛 ID 不一致");
  }
  const resolvedContestId = contestId ?? input.contest_id ?? null;

  // 比赛内每道题提交次数上限（含 error 计数）
  if (resolvedContestId) {
    await assertContestSubmissionLimit(
      resolvedContestId,
      userId,
      input.problem_id,
    );
  }

  // 行级锁 + 读取最新题目配置
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

  // 统一访问解析：普通入口 private 题非 owner/admin 拒绝；
  // 竞赛入口先经 verifyContestAccess 校验成员+窗口。
  const contestAccess = resolvedContestId
    ? await verifyContestAccess(userId, resolvedContestId, problem.id)
    : null;
  const access = resolveProblemAccess(problem, {
    viewerId: userId,
    isAdmin,
    contestAccess,
  });
  if (!access.allowed) {
    throw new ForbiddenError("无权对该题目提交");
  }
  // 服务层防御：竞赛提交只允许 running 窗口（contest 路由已拦截，这里防未来调用方绕过）。
  if (resolvedContestId && contestAccess && !contestAccess.running) {
    throw new ForbiddenError("仅可在竞赛进行期间提交");
  }

  if (problem.submission_mode !== "prediction") {
    throw new BadRequestError("该题目不支持 prediction 提交");
  }

  const ext = predictionFileExtension(input.file_name);

  // 双层大小限制（复用题目 artifact_max_size_mb + NOJ 硬上限）
  const hardLimit = getArtifactHardLimit();
  const problemLimit = problem.artifact_max_size_mb
    ? problem.artifact_max_size_mb * 1024 * 1024
    : hardLimit;
  const maxSizeBytes = Math.min(problemLimit, hardLimit);

  // 取头部做扩展名 + 魔数校验，rest 可重放供上传消费。
  const { first, rest } = await peekFirstChunk(input.file_stream);
  validatePredictionFile(input.file_name, first);

  // 流式上传到存储（复用 artifacts/ 前缀，便于既有治理脚本覆盖）
  const storage = await getStorageProvider();
  const storageKey = `artifacts/${crypto.randomUUID()}${ext}`;
  let predictionStorageUrl: string;
  try {
    predictionStorageUrl = await storage.putStream(
      storageKey,
      rest,
      "application/octet-stream",
      maxSizeBytes,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("超过大小限制")) {
      throw new BadRequestError(
        `文件超过大小限制（最大 ${Math.floor(maxSizeBytes / 1024 / 1024)}MB）`,
      );
    }
    throw err;
  }

  const id = crypto.randomUUID();
  const publicId = generatePublicId("sub");
  const now = new Date().toISOString();

  // 获取支持包 download URL
  let download_url: string | undefined;
  if (problem.support_package_storage_url) {
    try {
      download_url = await storage.downloadUrl(
        problem.support_package_storage_url,
      );
    } catch (err) {
      logger.error("获取支持包 download URL 失败", {
        storage_url: problem.support_package_storage_url,
        err,
      });
    }
  }

  // 校验 runtime_config：prediction 只要求 evaluator（无 Solution 容器）。
  const runtimeConfig = problem.runtime_config as
    | RuntimeConfig
    | null
    | undefined;
  if (!runtimeConfig || !runtimeConfig.evaluator) {
    await storage.delete(predictionStorageUrl).catch(() => {});
    throw new AppError(
      "题目缺少 runtime_config.evaluator 配置，无法评测",
      500,
      "RUNTIME_CONFIG_MISSING",
    );
  }
  await validateJudgeImageWithKind(runtimeConfig.evaluator.image, "evaluator");

  // 固定语言 python3（占位，保持列非空）
  const language = "python3";

  // 预测文件下载 URL（judge 交付层）
  let predictionDownloadUrl: string;
  try {
    predictionDownloadUrl = await storage.downloadUrl(predictionStorageUrl);
  } catch (err) {
    await storage.delete(predictionStorageUrl).catch(() => {});
    logger.error("获取 prediction 文件 download URL 失败", {
      storage_url: predictionStorageUrl,
      err,
    });
    throw new AppError(
      "提交失败：无法生成预测文件下载地址，请稍后重试",
      500,
      "PREDICTION_DOWNLOAD_ERROR",
    );
  }

  const priority = await resolveJudgeTaskPriority(
    resolvedContestId,
    "submission",
  );

  const task = buildJudgeTask({
    submission_id: id,
    problem_id: input.problem_id,
    user_id: userId,
    priority,
    submission_mode: "prediction",
    runtime_config: runtimeConfig,
    download_url,
    artifact_download_url: predictionDownloadUrl,
    language,
    code: "",
    file_name: input.file_name,
  });

  try {
    await db.insert(submissions).values({
      id,
      public_id: publicId,
      user_id: userId,
      problem_id: input.problem_id,
      contest_id: resolvedContestId,
      client_ip: clientIp && clientIp !== "unknown" ? clientIp : null,
      language,
      code: "",
      file_name: input.file_name,
      artifact_storage_url: predictionStorageUrl,
      status: "pending",
      created_at: now,
    });
  } catch (dbErr) {
    await storage.delete(predictionStorageUrl).catch(() => {});
    logger.error("prediction 提交记录插入失败", { err: dbErr });
    throw new AppError(
      "提交失败：数据库写入错误，请稍后重试",
      500,
      "SUBMISSION_DB_ERROR",
    );
  }

  try {
    await pushJudgeTask(task);
    await db.update(submissions).set({ status: "judging" }).where(
      and(eq(submissions.id, id), eq(submissions.status, "pending")),
    );
    await publishSseEvent(Channels.queue, { type: "queue:changed" });
    if (resolvedContestId) {
      await publishSseEvent(
        Channels.contestSubmission(resolvedContestId),
        {
          type: "contest:submission:created",
          contest_id: resolvedContestId,
          submission_id: id,
          user_id: userId,
          problem_id: input.problem_id,
        },
      );
    }
  } catch (mqErr) {
    logger.error("prediction 评测任务推送失败", {
      submission_id: id,
      err: mqErr,
    });
    // 入队失败：删除预测文件并标记 error（prediction 不支持重测，不留孤儿）
    await storage.delete(predictionStorageUrl).catch(() => {});
    if (!isRetryableJudgeQueueError(mqErr)) {
      await db.update(submissions)
        .set({
          status: "error",
          judge_finished_at: new Date().toISOString(),
        })
        .where(eq(submissions.id, id));
    }
    throw new AppError(
      "提交失败：评测队列暂时不可用，请稍后重试",
      500,
      "SUBMISSION_QUEUE_ERROR",
    );
  }

  return {
    id,
    public_id: publicId,
    user_id: userId,
    problem_id: input.problem_id,
    contest_id: resolvedContestId,
    language,
    code: "",
    file_name: input.file_name,
    status: "judging",
    created_at: now,
  };
}
