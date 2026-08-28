/**
 * Artifact 提交服务（类 Kaggle 产物提交）。
 *
 * 负责：
 * - 校验题目 submission_mode=artifact
 * - 流式上传 zip 到存储（local 临时文件 / S3 multipart）
 * - 双层大小限制（题目 artifact_max_size_mb + NOJ 硬上限）
 * - 创建提交记录并推送评测任务
 * - 评测/入队失败时立即删除 artifact
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/connection.ts";
import { problems, submissions } from "../../db/schema.ts";
import { AppError, BadRequestError, NotFoundError } from "../../lib/errors.ts";
import { getStorageProvider } from "../../lib/storage/mod.ts";
import { generatePublicId } from "../../lib/public-id.ts";
import {
  isRetryableJudgeQueueError,
  pushJudgeTask,
} from "../../mq/producer.ts";
import { validateJudgeImageWithKind } from "../judge-images.ts";
import { assertContestSubmissionLimit } from "../contest/contests.ts";
import { buildJudgeTaskLlm } from "../../lib/llm-token.ts";
import { buildJudgeTaskLlmForProvider } from "../../lib/llm-token.ts";
import { getUserLlmProvider } from "../llm.ts";
import { Channels, publishEvent } from "../../lib/event-bus.ts";
import { logger } from "../../lib/logging.ts";
import type { JudgeTask, JudgeTaskLlm } from "../../types/index.ts";
import type { LlmConfig, RuntimeConfig } from "../../types/problems.ts";
import type { SubmissionResponse } from "./submissions-types.ts";

/** NOJ artifact 硬上限默认值：2GB。 */
export const DEFAULT_ARTIFACT_MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 读取 NOJ artifact 硬上限（字节）。
 * 环境变量 `NOJ_ARTIFACT_MAX_SIZE_MB` 可覆盖，单位 MB。
 */
export function getArtifactHardLimit(): number {
  const raw = Deno.env.get("NOJ_ARTIFACT_MAX_SIZE_MB");
  if (raw) {
    const mb = Number(raw);
    if (Number.isFinite(mb) && mb > 0) {
      return Math.floor(mb * 1024 * 1024);
    }
  }
  return DEFAULT_ARTIFACT_MAX_SIZE_BYTES;
}

/** 从 web stream 读取首个 chunk，并返回可重新播放的流（用于 zip magic 校验）。 */
async function peekFirstChunk(
  stream: ReadableStream<Uint8Array>,
): Promise<{ first: Uint8Array; rest: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const { done, value } = await reader.read();
  if (done) {
    return {
      first: new Uint8Array(0),
      rest: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    };
  }
  const first = value ?? new Uint8Array(0);
  let firstPending = true;
  const rest = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (firstPending) {
        firstPending = false;
        controller.enqueue(first);
        return;
      }
      const r = await reader.read();
      if (r.done) {
        controller.close();
        reader.releaseLock();
      } else if (r.value && r.value.length > 0) {
        controller.enqueue(r.value);
      }
    },
    cancel() {
      reader.releaseLock();
    },
  });
  return { first, rest };
}

/**
 * 创建 artifact 提交。
 *
 * @param userId 提交用户
 * @param input problem_id / file_name / file_stream / contest_id
 * @param contestId 路由层显式竞赛 ID（可选）
 */
export async function createArtifactSubmission(
  userId: string,
  input: {
    problem_id: string;
    file_name: string;
    file_stream: ReadableStream<Uint8Array>;
    contest_id?: string;
    llm_provider_config_id?: string;
  },
  contestId?: string,
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

  if (problem.submission_mode !== "artifact") {
    throw new BadRequestError("该题目不支持 artifact 提交");
  }
  if (!input.file_name.toLowerCase().endsWith(".zip")) {
    throw new BadRequestError("仅支持 .zip 格式文件");
  }

  // 固定语言 python3
  const language = "python3";

  // 双层大小限制
  const hardLimit = getArtifactHardLimit();
  const problemLimit = problem.artifact_max_size_mb
    ? problem.artifact_max_size_mb * 1024 * 1024
    : hardLimit;
  const maxSizeBytes = Math.min(problemLimit, hardLimit);

  // 校验 zip magic bytes（PK 头）
  const { first, rest } = await peekFirstChunk(input.file_stream);
  if (
    first.length < 4 || first[0] !== 0x50 || first[1] !== 0x4b
  ) {
    throw new BadRequestError("文件不是有效的 zip 格式");
  }

  // 流式上传到存储
  const storage = await getStorageProvider();
  const storageKey = `artifacts/${crypto.randomUUID()}.zip`;
  let artifactStorageUrl: string;
  try {
    artifactStorageUrl = await storage.putStream(
      storageKey,
      rest,
      "application/zip",
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

  // 校验 runtime_config
  const runtimeConfig = problem.runtime_config as
    | RuntimeConfig
    | null
    | undefined;
  if (!runtimeConfig) {
    await storage.delete(artifactStorageUrl).catch(() => {});
    throw new AppError(
      "题目缺少 runtime_config 配置，无法评测",
      500,
      "RUNTIME_CONFIG_MISSING",
    );
  }
  await validateJudgeImageWithKind(runtimeConfig.evaluator.image, "evaluator");
  await validateJudgeImageWithKind(runtimeConfig.solution.image, "solution");

  let llmTask: JudgeTaskLlm | undefined;
  const llmConfig = problem.llm_config as LlmConfig | null;
  if (llmConfig) {
    llmTask = await buildJudgeTaskLlm(
      llmConfig,
      id,
      input.problem_id,
      userId,
      runtimeConfig,
    );
  }
  let userLlmTask: JudgeTaskLlm | undefined;
  if (input.llm_provider_config_id) {
    const provider = await getUserLlmProvider(
      userId,
      input.llm_provider_config_id,
    );
    if (!provider.enabled) {
      throw new BadRequestError(
        "用户模型配置已停用",
        "BYOK_CONFIG_UNAVAILABLE",
      );
    }
    userLlmTask = await buildJudgeTaskLlmForProvider(
      provider.id,
      provider.model,
      id,
      input.problem_id,
      userId,
      runtimeConfig,
    );
  }

  // artifact 下载 URL（judge 交付层）
  let artifactDownloadUrl: string;
  try {
    artifactDownloadUrl = await storage.downloadUrl(artifactStorageUrl);
  } catch (err) {
    await storage.delete(artifactStorageUrl).catch(() => {});
    logger.error("获取 artifact download URL 失败", {
      storage_url: artifactStorageUrl,
      err,
    });
    throw new AppError(
      "提交失败：无法生成 artifact 下载地址，请稍后重试",
      500,
      "ARTIFACT_DOWNLOAD_ERROR",
    );
  }

  const task: JudgeTask = {
    submission_id: id,
    problem_id: input.problem_id,
    runtime_config: runtimeConfig,
    download_url,
    artifact_download_url: artifactDownloadUrl,
    language,
    code: "",
    file_name: input.file_name,
    ...(llmTask ? { llm: llmTask } : {}),
    ...(userLlmTask ? { user_llm: userLlmTask } : {}),
  };

  try {
    await db.insert(submissions).values({
      id,
      public_id: publicId,
      user_id: userId,
      problem_id: input.problem_id,
      contest_id: resolvedContestId,
      language,
      code: "",
      file_name: input.file_name,
      artifact_storage_url: artifactStorageUrl,
      llm_provider_config_id: input.llm_provider_config_id,
      status: "pending",
      created_at: now,
    });
  } catch (dbErr) {
    await storage.delete(artifactStorageUrl).catch(() => {});
    logger.error("artifact 提交记录插入失败", { err: dbErr });
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
    publishEvent(Channels.queue, JSON.stringify({ type: "queue:changed" }));
    if (resolvedContestId) {
      publishEvent(
        Channels.contestSubmission(resolvedContestId),
        JSON.stringify({
          type: "contest:submission:created",
          contest_id: resolvedContestId,
          submission_id: id,
          user_id: userId,
          problem_id: input.problem_id,
        }),
      );
    }
  } catch (mqErr) {
    logger.error("artifact 评测任务推送失败", {
      submission_id: id,
      err: mqErr,
    });
    // 入队失败：删除 artifact 并标记 error（artifact 不支持重测，不留孤儿）
    await storage.delete(artifactStorageUrl).catch(() => {});
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
