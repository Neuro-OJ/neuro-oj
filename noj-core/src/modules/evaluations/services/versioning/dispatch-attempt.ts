/** 代码/产物评测尝试派发（重测），以及代码升级副本创建后的派发。 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  submissions,
} from "../../../../shared/db/schema.ts";
import { getLogger } from "@logtape/logtape";
import { getStorageProvider } from "../../../assets/storage/mod.ts";
import type { LlmConfig } from "../../../problems/types/problems.ts";
import type { ProblemContentV1 } from "../../../problems/types/problem-content.ts";
import { buildJudgeTaskLlm } from "../../../platform/contracts/cross-module/gateway_services_llm-token.ts";
import type { FrozenLlmExecution } from "../../../platform/contracts/cross-module/gateway_services_llm-token.ts";
import { classifyJudgeQueueError, pushJudgeTask } from "../../mq/producer.ts";
import { prepareJudgeTask } from "../prepare-judge-task.ts";
import { type JudgeTask, toJudgeSubmissionMode } from "../../types/index.ts";
import {
  ensureJobAttempt,
  type PreparedJobExecution,
  type UpgradeQuotaConsumer,
  UpgradeQuotaDeferredError,
} from "./job-attempt.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import {
  executionSnapshot,
  scriptTemplateOf,
  versionSupportPackageDownload,
} from "./version-execution.ts";
import {
  type ClaimedJobItem,
  completeJobItem,
  markJobItemDispatched,
  renewJobItemLease,
  requeueJobItem,
  revokeAttemptLlmTokens,
  scheduleDispatchRetryOrFail,
} from "./job-worker.ts";
import type {
  DispatchOutcome,
  DispatchSource,
  JobUpgradeContext,
  LeaseGate,
} from "./dispatch-types.ts";

const logger = getLogger(["noj", "submission"]);

/**
 * 读取重派目标尝试（含冻结快照，用于"只续签凭据、不重解析默认配置"）。
 */
export async function loadAttemptWithSnapshot(
  attemptId: string,
): Promise<typeof evaluationAttempts.$inferSelect | null> {
  const [row] = await getDb().select().from(evaluationAttempts).where(
    eq(evaluationAttempts.id, attemptId),
  ).limit(1);
  return row ?? null;
}

/** 派发一次 Judge 执行（重测与升级共用）。 */
export async function dispatchJudgeAttempt(input: {
  item: ClaimedJobItem;
  owner: string;
  attemptSource: {
    kind: "submission";
    id: string;
    problem_id: string;
    contest_id: string | null;
  };
  /** 任务/LLM token 使用的提交 ID（升级时为**新提交**）。 */
  submissionId: string;
  upgradeContext?: JobUpgradeContext;
  source: DispatchSource;
  content: Exclude<ProblemContentV1, { kind: "objective" }>;
  sourceKind: "rejudge" | "upgrade";
  priority: "low" | "medium";
  quotaConsumer: UpgradeQuotaConsumer;
  lease: LeaseGate;
}): Promise<DispatchOutcome> {
  const { item, owner, source, content } = input;
  const targetVersionId = item.target_version_id as string;
  const llmConfig = content.kind === "ai"
    ? (content.llm_config as LlmConfig | null)
    : null;

  // 阶段 1/2 的产物需要跨越 catch 之后的派发代码使用；上面的 catch 覆盖全部分支
  // （成功路径必然赋值，否则已 return/throw），因此使用明确赋值断言。
  let attempt!: typeof evaluationAttempts.$inferSelect;
  let destinationId!: string;
  let task!: JudgeTask;
  // 预检/配置类失败（AppError < 500）必须就地写条目 `failed`：
  // 阶段 1 的任何失败都发生在创建尝试之前，不得留下尝试行；阶段 2 的失败
  // 由 `ensureJobAttempt` 的事务整体回滚（同样不留残留）。
  try {
    // ── 阶段 1：准备目标执行上下文（**不落库**） ────────────────────────────
    //
    // #7：先确定 attempt / 副本 ID，再完成支持包存在性、LLM 服务/模型/预算预检与
    // 完整非敏感快照；任何一步失败都不会留下不该存在的尝试行。
    // **sequence 不在此冻结**（复审问题 1）：它只能在源提交行锁内由 `createAttempt`
    // 统一分配；任务封套在事务提交后回填 `attempt.sequence`。
    // 重派（item.attempt_id 已存在）只**续签交付凭据**，Provider/模型/预算取自
    // 既有快照，绝不重新解析当前默认服务配置。
    const existing = item.attempt_id
      ? await loadAttemptWithSnapshot(item.attempt_id)
      : null;
    if (item.attempt_id && !existing) {
      await completeJobItem(item.id, {
        leaseOwner: owner,
        status: "failed",
        reasonCode: "JOB_ATTEMPT_MISSING",
        reasonMessage: "尝试关联已失效，无法恢复派发",
      });
      return "failed";
    }
    const attemptId = existing?.id ?? crypto.randomUUID();
    destinationId = input.sourceKind === "upgrade"
      ? (existing?.submission_id ?? crypto.randomUUID())
      : source.id;
    // 支持包**存在性**（缺失抛 SUPPORT_PACKAGE_MISSING）与下载地址（重派重新签发）
    const downloadUrl = await versionSupportPackageDownload(targetVersionId);
    let artifactDownloadUrl: string | undefined;
    if (source.artifact_storage_url) {
      const storage = await getStorageProvider();
      artifactDownloadUrl = await storage.downloadUrl(
        source.artifact_storage_url,
      );
    }

    // LLM 预检 + 凭据：首次解析平台默认并冻结；重派使用快照中的 provider/model/预算
    const previousSnapshot = (existing?.task_snapshot ?? null) as
      | Record<string, unknown>
      | null;
    const frozenLlm = previousSnapshot?.llm_execution as
      | FrozenLlmExecution
      | undefined;
    let llmTask;
    if (llmConfig && content.kind === "ai") {
      llmTask = await buildJudgeTaskLlm(
        llmConfig,
        destinationId,
        source.problem_id,
        source.user_id,
        content.runtime_config,
        {
          // 同一尝试重派共享预算：重新签发 token 不重置额度
          attemptId,
          domainId: source.domain_id ?? DEFAULT_DOMAIN_ID,
          problemVersionId: targetVersionId,
          frozen: frozenLlm,
        },
      );
    }

    task = await prepareJudgeTask({
      attempt_id: attemptId,
      problem_version_id: targetVersionId,
      submission_id: destinationId,
      problem_id: source.problem_id,
      user_id: source.user_id,
      priority: input.priority,
      // 提交模式取自目标版本内容（发布后不可变）：prediction 提交据此走单容器
      // 评分路径，代码/产物提交沿用双容器。
      submission_mode: content.kind === "ai"
        ? toJudgeSubmissionMode(content.submission_mode)
        : "code",
      runtime_config: content.runtime_config,
      download_url: downloadUrl,
      artifact_download_url: artifactDownloadUrl,
      language: source.language,
      code: source.artifact_storage_url ? "" : source.code,
      script_template: source.language === "ui"
        ? scriptTemplateOf(content)
        : undefined,
      file_name: source.file_name ?? undefined,
      llm: llmTask,
    });

    // 完整非敏感快照（排除源码、短期下载地址与 token）：事务内与尝试一同落库
    const prepared: PreparedJobExecution = {
      attemptId,
      destinationId,
      taskSnapshot: {
        ...executionSnapshot(
          task,
          llmConfig,
          previousSnapshot,
          source.domain_id ?? DEFAULT_DOMAIN_ID,
        ),
        batch_job_id: item.job_id,
        submission_mode: content.kind === "ai"
          ? content.submission_mode
          : "code",
      },
    };

    // ── 阶段 2：一个事务内创建副本 / 尝试 / 条目关联 ──────────────────────
    attempt = await ensureJobAttempt({
      item,
      owner,
      source,
      kind: input.sourceKind,
      context: input.upgradeContext,
      prepared,
    }, input.quotaConsumer);
  } catch (err) {
    // #9：额度不足 → 条目**延期**（可重试、不计失败、不发新提交）
    if (err instanceof UpgradeQuotaDeferredError) {
      await requeueJobItem(
        item.id,
        Math.max(1, Math.ceil(err.retryAfterMs / 1000)),
        owner,
      );
      return "deferred";
    }
    // #10：锁内复查发现源正在评测 / 已删除 → **skipped**（其它配置/交付物错误仍 failed）
    if (
      err instanceof AppError &&
      (err.code === "SOURCE_JUDGING" || err.code === "SOURCE_DELETED")
    ) {
      await completeJobItem(item.id, {
        leaseOwner: owner,
        status: "skipped",
        reasonCode: err.code,
        reasonMessage: err.message,
      });
      return "skipped";
    }
    // 租约丢失交由 worker 层延期（不写终态，条目应由新持有者接管）
    if (err instanceof AppError && err.code === "JOB_LEASE_LOST") throw err;
    // 预检/永久失败（Provider 缺配、支持包缺失、目标配置非法等）：条目 failed，
    // 且**不留尝试行**（阶段 1 失败时尝试尚未创建）
    if (err instanceof AppError && err.statusCode < 500) {
      await completeJobItem(item.id, {
        leaseOwner: owner,
        status: "failed",
        reasonCode: err.code,
        reasonMessage: err.message,
      });
      return "failed";
    }
    throw err;
  }

  // 落库返回的 `sequence` 是唯一权威（源提交行锁内统一分配：MAX(尝试)+1 与源
  // `rejudge_seq` 取大者）。任务封套必须与之一致，否则结果回写会因 sequence
  // 不匹配被静默丢弃（复审问题 1：存量提交 `rejudge_seq=7` 无尝试行时落库 7、
  // 封套 0 → `applied=false`，提交卡 judging、活动尝试不清）。
  task = { ...task, rejudge_seq: attempt.sequence };

  if (["finished", "error", "superseded"].includes(attempt.state)) {
    await completeJobItem(item.id, {
      leaseOwner: owner,
      status: attempt.result_kind === "graded" ? "succeeded" : "failed",
      attemptId: attempt.id,
    });
    // 尝试已是终态（含 superseded）：补一次**幂等**的统一吊销后处理，
    // 保证任何在此观察到终态的路径都不会留下可用 token。
    await revokeAttemptLlmTokens({
      attemptId: attempt.id,
      submissionId: attempt.submission_id ?? attempt.objective_submission_id,
      taskSnapshot: attempt.task_snapshot,
    });
    return "dispatched";
  }

  // 续租后再派发：长任务不会因 lease 过期被其他 worker 重复领取
  if (!await renewJobItemLease(item.id, owner)) return "deferred";
  // 紧邻推送再复查一次心跳结论：续租成功但心跳已观察到丢失（被接管）时不能推，
  // 否则持有者与本进程会各推一次评测。
  try {
    await input.lease.assertHeld();
  } catch (err) {
    if (err instanceof AppError && err.code === "JOB_LEASE_LOST") {
      return "deferred";
    }
    throw err;
  }
  try {
    await pushJudgeTask(task);
  } catch (err) {
    // §5.7：容量不足属"稍后重试"（不计失败、不退避）；网络失败按 1/2/4/8/16
    // 秒指数退避；永久错误（消息过大、队列布局需协调升级）重试不可能成功，
    // 必须立即终结条目并统一终结已创建的在途尝试（保留历史判定）。
    const queueErrorKind = classifyJudgeQueueError(err);
    if (queueErrorKind === "capacity") {
      await requeueJobItem(item.id, 5, owner);
      return "deferred";
    }
    if (queueErrorKind === "permanent") {
      await completeJobItem(item.id, {
        leaseOwner: owner,
        status: "failed",
        attemptId: attempt.id,
        reasonCode: "DISPATCH_PERMANENT_FAILURE",
        reasonMessage: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    }
    await scheduleDispatchRetryOrFail(item.id, {
      leaseOwner: owner,
      reasonCode: "DISPATCH_FAILED",
      reasonMessage: err instanceof Error ? err.message : String(err),
    });
    return "retry";
  }

  await markJobItemDispatched(item.id, attempt.id, owner);
  await getDb().update(submissions).set({ status: "judging" }).where(and(
    eq(submissions.id, destinationId),
    eq(submissions.active_attempt_id, attempt.id),
    eq(submissions.status, "pending"),
  ));
  logger.info("批任务条目已派发", {
    job_id: item.job_id,
    item_id: item.id,
    attempt_id: attempt.id,
    target_version_id: targetVersionId,
  });
  return "dispatched";
}

/**
 * 代码/产物升级：创建新提交（沿用原用户与原始代码/产物，记录升级来源、使用当前
 * 时间；`context = source_contest` 时保留原竞赛），再对新提交派发评测。
 */
export async function dispatchCodeUpgrade(input: {
  item: ClaimedJobItem;
  owner: string;
  source: DispatchSource;
  content: Exclude<ProblemContentV1, { kind: "objective" }>;
  upgradeContext: JobUpgradeContext;
  quotaConsumer: UpgradeQuotaConsumer;
  lease: LeaseGate;
}): Promise<DispatchOutcome> {
  const { item, owner, source, content, upgradeContext, lease } = input;
  return await dispatchJudgeAttempt({
    item,
    owner,
    source,
    content,
    attemptSource: {
      kind: "submission",
      id: source.id,
      problem_id: source.problem_id,
      contest_id: upgradeContext === "source_contest"
        ? source.contest_id
        : null,
    },
    submissionId: source.id,
    sourceKind: "upgrade",
    upgradeContext,
    priority: "medium",
    quotaConsumer: input.quotaConsumer,
    lease,
  });
}
