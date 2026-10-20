import { publishQueueChange } from "../queue.ts";
/**
 * Artifact 提交服务（类 Kaggle 产物提交），同时承载 prediction（预测结果文件）提交。
 *
 * 两种模式共用同一条「上传文件 → 版本绑定 → 尝试 → 入队」流程，差异由
 * {@link UploadedSubmissionSpec} 描述（文件名/魔数校验、存储扩展名、镜像要求）。
 *
 * 负责：
 * - 校验题目 submission_mode 与上传模式一致
 * - 流式上传到存储（local 临时文件 / S3 multipart）
 * - 双层大小限制（题目 artifact_max_size_mb + NOJ 硬上限）
 * - 创建提交记录并推送评测任务
 * - 产物保留到提交删除；上传补偿通过共享引用守卫
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { problems, submissions } from "../../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  assertStorageObjectBindable,
  compensateUploadedObject,
  getStorageProvider,
  registerStreamedStorageObject,
} from "../../../system/index.ts";
import { generatePublicId } from "../../../../shared/security/public-id.ts";
import {
  isRetryableJudgeQueueError,
  pushJudgeTask,
} from "../../mq/producer.ts";
import { validateJudgeImageWithKind } from "../../../system/index.ts";
import { assertContestSubmissionLimit } from "../../../../modules/contests/index.ts";
import { verifyContestAccess } from "../../../../modules/contests/index.ts";
import {
  assertDefaultProblemSource,
  evaluateProblemAccess,
  resolveDefaultExecutionContext,
} from "../../../../modules/problems/index.ts";
import { resolveJudgeTaskPriority } from "./judge-priority.ts";
import { buildJudgeTaskLlm } from "../../../gateway/index.ts";
import {
  Channels,
  publishSseEvent,
} from "../../../../shared/sse/event-bus.ts";
import { getLogger } from "@logtape/logtape";
import { peekFirstChunk } from "./stream-peek.ts";

const logger = getLogger(["noj", "submission"]);
import type { JudgeTask, JudgeTaskLlm } from "../../types/index.ts";
import { prepareJudgeTask } from "../prepare-judge-task.ts";
import {
  type DomainExecutionRequest,
  lockDomainExecution,
  resolveDomainExecution,
} from "../workspace-execution.ts";
import {
  attachDomainStorageUpload,
  consumeDomainSubmissionQuota,
  DEFAULT_DOMAIN_ID,
  growDomainStorageUpload,
  releaseDomainStorageUpload,
  reserveDomainStorageUpload,
  settleDomainStorageUpload,
} from "../../../workspace/index.ts";
import { isOiRuntimeConfig } from "../../../../modules/problems/index.ts";
import type { SubmissionResponse } from "./submissions-types.ts";
import { createAttempt } from "../versioning/attempts.ts";
import { applyAttemptResult } from "../versioning/result-write.ts";
import {
  bumpSubmissionCountRevisions,
  lockProjectionHosts,
} from "../versioning/projection.ts";
import {
  executionSnapshot,
  versionSupportPackageDownload,
} from "../versioning/version-execution.ts";
import {
  assertVersionAcceptsSubmission,
  resolveSubmissionVersion,
} from "../versioning/submission-version.ts";

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

/** 上传文件类提交的输入（单文件流）。 */
export interface UploadedSubmissionInput {
  problem_id: string;
  file_name: string;
  file_stream: ReadableStream<Uint8Array>;
  contest_id?: string;
  /** 提交时版本（Handbook §4.2）：上传类提交必填，不静默绑定最新版。 */
  version_id?: string;
}

/** 上传类提交的模式差异（artifact zip / prediction 数据文件）。 */
export interface UploadedSubmissionSpec {
  mode: "artifact" | "prediction";
  /** 模式不匹配时的提示。 */
  modeMismatchMessage: string;
  /** 上传前的文件名校验（不读流）。 */
  validateFileName(fileName: string): void;
  /** 基于首块字节的格式校验（魔数等）。 */
  validateHead(fileName: string, first: Uint8Array): void;
  /** 存储对象扩展名（含点）。 */
  storageExtension(fileName: string): string;
  contentType: string;
}

const ARTIFACT_SPEC: UploadedSubmissionSpec = {
  mode: "artifact",
  modeMismatchMessage: "该题目不支持 artifact 提交",
  validateFileName(fileName) {
    if (!fileName.toLowerCase().endsWith(".zip")) {
      throw new BadRequestError("仅支持 .zip 格式文件");
    }
  },
  validateHead(_fileName, first) {
    // 校验 zip magic bytes（PK 头）
    if (first.length < 4 || first[0] !== 0x50 || first[1] !== 0x4b) {
      throw new BadRequestError("文件不是有效的 zip 格式");
    }
  },
  storageExtension: () => ".zip",
  contentType: "application/zip",
};

/** 每批最多 1MiB，写入存储前原子预留该批实际字节，失败由调用方释放预约。 */
function meteredArtifactStream(
  source: ReadableStream<Uint8Array>,
  domainId: string,
  reservationId: string,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let pending: Uint8Array | undefined;
  let ended = false;
  const batchSize = 1024 * 1024;
  return new ReadableStream({
    async pull(controller) {
      try {
        const buffer = new Uint8Array(batchSize);
        let size = 0;
        while (size < batchSize && !ended) {
          if (!pending?.length) {
            const next = await reader.read();
            if (next.done) {
              ended = true;
              break;
            }
            pending = next.value;
          }
          const take = Math.min(pending.length, batchSize - size);
          buffer.set(pending.subarray(0, take), size);
          pending = pending.subarray(take);
          size += take;
        }
        if (!size) {
          controller.close();
          reader.releaseLock();
          return;
        }
        const batch = buffer.subarray(0, size);
        await growDomainStorageUpload(
          domainId,
          reservationId,
          batch.byteLength,
        );
        controller.enqueue(batch);
      } catch (error) {
        await reader.cancel(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });
}

/**
 * 创建 artifact 提交。
 *
 * @param userId 提交用户
 * @param input problem_id / file_name / file_stream / contest_id
 * @param contestId 路由层显式竞赛 ID（可选）
 */
export function createArtifactSubmission(
  userId: string,
  input: UploadedSubmissionInput,
  contestId?: string,
  isAdmin = false,
  domainRequest?: DomainExecutionRequest,
): Promise<SubmissionResponse> {
  return createUploadedSubmission(
    ARTIFACT_SPEC,
    userId,
    input,
    contestId,
    isAdmin,
    domainRequest,
  );
}

/**
 * 上传文件类提交的共用流程（artifact / prediction）。
 *
 * @param spec 模式差异描述
 * @param userId 提交用户
 * @param input problem_id / file_name / file_stream / contest_id
 * @param contestId 路由层显式竞赛 ID（可选）
 */
export async function createUploadedSubmission(
  spec: UploadedSubmissionSpec,
  userId: string,
  input: UploadedSubmissionInput,
  contestId?: string,
  isAdmin = false,
  domainRequest?: DomainExecutionRequest,
): Promise<SubmissionResponse> {
  const db = getDb();
  if (contestId && input.contest_id && contestId !== input.contest_id) {
    throw new BadRequestError("竞赛 ID 不一致");
  }
  const requestedContestId = contestId ?? input.contest_id ?? null;
  if (domainRequest && requestedContestId && !domainRequest.contestId) {
    throw new BadRequestError("域内练习不能携带比赛上下文");
  }
  const domainExecution = domainRequest
    ? await resolveDomainExecution(domainRequest, userId, input.version_id)
    : null;
  if (
    domainExecution?.contestId && requestedContestId &&
    domainExecution.contestId !== requestedContestId
  ) throw new BadRequestError("比赛路径与提交上下文不一致");
  const resolvedContestId = domainExecution?.contestId ?? requestedContestId;
  if (domainExecution && domainExecution.problem.id !== input.problem_id) {
    throw new NotFoundError("域题目引用与内部身份不一致");
  }

  // 比赛内每道题提交次数上限（含 error 计数）
  if (resolvedContestId) {
    await assertContestSubmissionLimit(
      resolvedContestId,
      userId,
      input.problem_id,
    );
  }

  // 读取最新题目配置（快照读，避免无事务包裹导致单语句 FOR UPDATE 锁即刻释放的伪锁缺陷）
  const lockedRows = domainExecution ? [domainExecution.problem] : await db
    .select()
    .from(problems)
    .where(eq(problems.id, input.problem_id))
    .limit(1);
  if (lockedRows.length === 0) {
    throw new NotFoundError("题目不存在");
  }
  const problem = lockedRows[0];
  if (!domainExecution) assertDefaultProblemSource(problem);

  // 统一访问解析：普通入口 private 题非 owner/admin 拒绝（被公开赛保密的题目同此
  // 口径，无法从独立路径提交）；竞赛入口先经 verifyContestAccess 校验成员+窗口。
  const contestAccess = resolvedContestId
    ? await verifyContestAccess(userId, resolvedContestId, problem.id, {
      domainId: domainExecution?.domain.id,
    })
    : null;
  if (!domainExecution) {
    const { result: access } = await evaluateProblemAccess(problem, {
      viewerId: userId,
      isAdmin,
      contestAccess,
    });
    if (!access.allowed) throw new ForbiddenError("无权对该题目提交");
  }
  // 服务层防御：竞赛提交只允许 running 窗口（contest 路由已拦截，这里防未来调用方绕过）。
  if (resolvedContestId && contestAccess && !contestAccess.running) {
    throw new ForbiddenError("仅可在竞赛进行期间提交");
  }

  if (!domainExecution && problem.submission_mode !== spec.mode) {
    throw new BadRequestError(spec.modeMismatchMessage);
  }
  spec.validateFileName(input.file_name);

  // 固定语言 python3
  const language = "python3";

  // 提交时版本（Handbook §4.2）：竞赛用固定版本（客户端覆盖 → 409），题库必须显式
  // 指定已发布版本。产物题的时机校验与产物大小上限都以**目标版本**为准，题目投影
  // 只在迁移期兜底。
  const versionResolution = await resolveSubmissionVersion(problem.id, {
    contestId: resolvedContestId,
    requestedVersionId: input.version_id,
    latestVersionId: problem.latest_version_id,
  });
  let versionMaxSizeMb: number | null = null;
  if (versionResolution.kind === "known") {
    const content = versionResolution.version.content;
    assertVersionAcceptsSubmission(content, {
      language,
      submissionMode: spec.mode,
    });
    if (content.kind === "ai") {
      versionMaxSizeMb = content.artifact_max_size_mb;
    }
  }

  if (versionResolution.kind !== "known") {
    throw new BadRequestError("必须指定已发布版本");
  }
  const content = versionResolution.version.content;
  if (content.kind !== "ai") {
    throw new BadRequestError("必须选择已发布的产物题版本");
  }
  const runtimeConfig = content.runtime_config;
  if (!runtimeConfig) {
    throw new AppError(
      "题目缺少 runtime_config 配置，无法评测",
      500,
      "RUNTIME_CONFIG_MISSING",
    );
  }
  if (isOiRuntimeConfig(runtimeConfig)) {
    throw new BadRequestError(`OI 题目不支持 ${spec.mode} 提交`);
  }
  // 所有不依赖上传内容的版本预检先完成，避免配置错误留下未登记的物理文件。
  const download_url = await versionSupportPackageDownload(
    versionResolution.version.version_id,
  );
  await validateJudgeImageWithKind(runtimeConfig.evaluator.image, "evaluator");
  // prediction 只运行 Evaluator：版本省略 solution 时跳过其镜像校验。
  if (runtimeConfig.solution) {
    await validateJudgeImageWithKind(runtimeConfig.solution.image, "solution");
  } else if (spec.mode !== "prediction") {
    throw new AppError(
      "题目缺少 solution 运行时配置，无法评测",
      500,
      "RUNTIME_CONFIG_SOLUTION_MISSING",
    );
  }

  // 双层大小限制（目标版本上限 + NOJ 硬上限）
  const hardLimit = getArtifactHardLimit();
  const problemLimit = versionMaxSizeMb
    ? versionMaxSizeMb * 1024 * 1024
    : hardLimit;
  const maxSizeBytes = Math.min(problemLimit, hardLimit);

  // 取头部做格式校验，rest 可重放供上传消费。
  const { first, rest } = await peekFirstChunk(input.file_stream);
  spec.validateHead(input.file_name, first);

  // 流式上传到存储（prediction 复用 artifacts/ 前缀，便于既有治理脚本覆盖）
  const storage = await getStorageProvider();
  const id = crypto.randomUUID();
  const uploadDomainId = domainExecution?.domain.id ??
    (await resolveDefaultExecutionContext(input.problem_id, userId, db))
      .domain_id;
  await consumeDomainSubmissionQuota(uploadDomainId, userId, id);
  const reservation = await reserveDomainStorageUpload({
    domainId: uploadDomainId,
    bytes: 0,
  });
  const reservationId = reservation.id;
  const storageKey = `artifacts/${crypto.randomUUID()}${
    spec.storageExtension(input.file_name)
  }`;
  let artifactStorageUrl: string;
  try {
    artifactStorageUrl = await storage.putStream(
      storageKey,
      meteredArtifactStream(rest, uploadDomainId, reservationId),
      spec.contentType,
      maxSizeBytes,
    );
  } catch (err) {
    await releaseDomainStorageUpload(uploadDomainId, reservationId);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("超过大小限制")) {
      throw new BadRequestError(
        `文件超过大小限制（最大 ${Math.floor(maxSizeBytes / 1024 / 1024)}MB）`,
      );
    }
    throw err;
  }

  // 尝试 ID 先于任务构造确定：任务 `run_id` 与之一致（Handbook §5.5）
  const attemptId = crypto.randomUUID();
  const publicId = generatePublicId("sub");
  const now = new Date().toISOString();
  let submissionCommitted = false;
  let task: JudgeTask;

  try {
    // 独立登记事务保留物理上传定位；后续业务事务失败仍可被恢复任务盘点。
    await db.transaction(async (tx) => {
      await registerStreamedStorageObject(
        { storageUrl: artifactStorageUrl },
        tx,
      );
      await attachDomainStorageUpload(
        uploadDomainId,
        reservationId,
        artifactStorageUrl,
        tx,
      );
    });
    let llmTask: JudgeTaskLlm | undefined;
    const llmConfig = content.llm_config;
    if (llmConfig) {
      llmTask = await buildJudgeTaskLlm(
        llmConfig,
        id,
        input.problem_id,
        userId,
        runtimeConfig,
        {
          // 额度与吊销按尝试隔离：重测拿到独立预算，旧尝试吊销不影响新尝试
          attemptId,
          domainId: domainExecution?.domain.id ?? DEFAULT_DOMAIN_ID,
          problemVersionId: versionResolution.version.version_id,
        },
      );
    }

    // artifact 下载 URL（judge 交付层）；失败也走统一上传补偿。
    let artifactDownloadUrl: string;
    try {
      artifactDownloadUrl = await storage.downloadUrl(artifactStorageUrl);
    } catch (err) {
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

    const priority = await resolveJudgeTaskPriority(
      resolvedContestId,
      "submission",
    );

    task = await prepareJudgeTask({
      attempt_id: attemptId,
      problem_version_id: versionResolution.version.version_id,
      submission_id: id,
      problem_id: input.problem_id,
      user_id: userId,
      priority,
      submission_mode: spec.mode,
      runtime_config: runtimeConfig,
      download_url,
      artifact_download_url: artifactDownloadUrl,
      language,
      code: "",
      file_name: input.file_name,
      llm: llmTask ?? undefined,
    });

    try {
      await db.transaction(async (tx) => {
        const workspace = domainExecution && domainRequest
          ? await lockDomainExecution(
            domainExecution,
            domainRequest,
            userId,
            input.version_id,
            tx,
          )
          : await resolveDefaultExecutionContext(input.problem_id, userId, tx);
        await lockProjectionHosts(tx, {
          kind: "submission",
          id,
          problem_id: input.problem_id,
          contest_id: resolvedContestId,
        });
        // 固定版本可能在外部 IO 期间切换；同一宿主锁内复查后才能写入。
        await resolveSubmissionVersion(input.problem_id, {
          contestId: resolvedContestId,
          requestedVersionId: input.version_id,
        }, tx);
        // 流式上传在上传前无法预测内容哈希（没有预约可用），因此在**同一事务内**先
        // 持登记行锁 stat 复核：物理存在才置 ready（可把 deleted/missing/unknown 复活），
        // 缺失则抛错拒绝绑定。此前这里只做 assertStorageObjectBindable，删除过的对象
        // 重传后登记行仍是 deleted，绑定永远被拒（复查问题 7）。
        await registerStreamedStorageObject({
          storageUrl: artifactStorageUrl,
        }, tx);
        await assertStorageObjectBindable(artifactStorageUrl, tx);
        await settleDomainStorageUpload(
          uploadDomainId,
          reservationId,
          artifactStorageUrl,
          tx,
        );
        await tx.insert(submissions).values({
          ...workspace,
          id,
          public_id: publicId,
          user_id: userId,
          problem_id: input.problem_id,
          contest_id: resolvedContestId,
          language,
          code: "",
          file_name: input.file_name,
          artifact_storage_url: artifactStorageUrl,
          status: "pending",
          // 提交时版本不可变：`known` 必须有版本，`legacy_unknown` 必须为空
          submitted_version_id: versionResolution.kind === "known"
            ? versionResolution.version.version_id
            : null,
          version_origin: versionResolution.kind === "known"
            ? "known"
            : "legacy_unknown",
          created_at: now,
        });
        await createAttempt({
          executor: tx,
          id: attemptId,
          source: {
            kind: "submission",
            id,
            problem_id: input.problem_id,
            contest_id: resolvedContestId,
          },
          problemVersionId: versionResolution.version.version_id,
          source_kind: "initial",
          taskSnapshot: {
            ...executionSnapshot(
              task,
              llmConfig,
              undefined,
              workspace.domain_id,
            ),
            submission_mode: spec.mode,
          },
          createdBy: userId,
        });
        // 新提交改变实际提交计数：同一事务递增题目/竞赛/global revision（§3.5）。
        await bumpSubmissionCountRevisions(tx, {
          problem_id: input.problem_id,
          contest_id: resolvedContestId,
        });
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.error("提交与初次评测尝试原子创建失败", {
        submission_id: id,
        err,
      });
      throw new AppError(
        "提交失败：数据库写入错误，请稍后重试",
        500,
        "SUBMISSION_DB_ERROR",
      );
    }
    submissionCommitted = true;
  } catch (err) {
    if (!submissionCommitted) {
      await compensateUploadedObject({ storageUrl: artifactStorageUrl })
        .then(() => releaseDomainStorageUpload(uploadDomainId, reservationId))
        .catch((cleanupError) => {
          logger.error("artifact 上传后处理失败，补偿清理失败", {
            storage_url: artifactStorageUrl,
            err: cleanupError,
          });
        });
    }
    throw err;
  }

  try {
    await pushJudgeTask(task);
    await db.update(submissions).set({ status: "judging" }).where(
      and(eq(submissions.id, id), eq(submissions.status, "pending")),
    );
    await publishQueueChange(id);
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
    logger.error("上传类提交评测任务推送失败", {
      mode: spec.mode,
      submission_id: id,
      err: mqErr,
    });
    // 已落库产物必须保留，瞬时入队失败由 sweeper 复用原尝试恢复。
    if (!isRetryableJudgeQueueError(mqErr)) {
      await applyAttemptResult({
        attemptId,
        resultKind: "platform_error",
        resultStatus: "DISPATCH_FAILED",
        score: null,
        accepted: false,
        output: "评测任务无法入队",
      });
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
