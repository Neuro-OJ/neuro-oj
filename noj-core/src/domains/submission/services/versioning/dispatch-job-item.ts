/**
 * 批量任务条目派发（Handbook §5.7）。
 *
 * worker 领取条目（`preparing` + lease）后按以下顺序执行：
 *
 * 1. **重新检查源**：源提交/客观题提交已删除 → `skipped` + `SOURCE_DELETED`；
 *    源仍在评测（在途尝试不是本条目）→ `skipped` + `SOURCE_JUDGING`（允许之后重试）；
 * 2. **目标版本固定**：`target_version_id` 在受理事务里已解析；`submitted` 模式
 *    遇到未知历史版本 → `skipped` + `LEGACY_VERSION_UNKNOWN`；
 * 3. **平台安全与交付物复检**：语言/提交模式必须被目标版本接受，artifact 对象必须
 *    存在且不超过目标版本上限——违反时 `failed` + 机器可读原因码，保留历史判定；
 * 4. **创建新尝试**：`sequence` 递增，旧尝试保留；任务与 LLM token 绑定本次尝试；
 * 5. **派发**：MQ 容量不足 → 等待下轮（不计失败）；网络失败 → 指数退避重试。
 *
 * 任务配置**只**来自目标版本内容，绝不读取题目当前投影：否则"用 V1 重测"会在
 * 题目发布 V2 后拿到 V2 的配置。
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  objectiveSubmissions,
  submissionJobItems,
  submissions,
} from "../../../../shared/db/schema.ts";
import { getLogger } from "@logtape/logtape";
import { getStorageProvider } from "../../../system/index.ts";
import type { LlmConfig } from "../../../catalog/index.ts";
import type { ProblemContentV1 } from "../../../catalog/index.ts";
import { buildJudgeTaskLlm } from "../../../gateway/index.ts";
import type { FrozenLlmExecution } from "../../../gateway/index.ts";
import { classifyJudgeQueueError, pushJudgeTask } from "../../mq/producer.ts";
import { prepareJudgeTask } from "../prepare-judge-task.ts";
import { getAttempt, isTerminalAttemptState } from "./attempts.ts";
import { submissionModeForLanguage } from "../../types/index.ts";
import type { JudgeTask } from "../../types/index.ts";
import {
  bumpSubmissionCountRevisions,
  lockProjectionHosts,
} from "./projection.ts";
import {
  consumeUpgradeQuota,
  defaultUpgradeQuotaConsumer,
  ensureJobAttempt,
  type PreparedJobExecution,
  type UpgradeQuotaConsumer,
  UpgradeQuotaDeferredError,
} from "./job-attempt.ts";
import { assertUpgradeAccess } from "./upgrade-access.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import {
  assertExecutionPreflight,
  executionSnapshot,
  versionSupportPackageDownload,
} from "./version-execution.ts";
import { evaluationAttempts } from "../../../../shared/db/schema.ts";
import {
  type ClaimedJobItem,
  completeJobItem,
  markJobItemDispatched,
  renewJobItemLease,
  requeueJobItem,
  revokeAttemptLlmTokens,
  scheduleDispatchRetryOrFail,
  startJobItemLeaseHeartbeat,
} from "./job-worker.ts";
import { loadPublishedVersionContent } from "./submission-version.ts";
import { refreshJobStatus } from "./rejudge-jobs.ts";

const logger = getLogger(["noj", "submission"]);

/** 派发结论（供测试与日志使用）。 */
export type DispatchOutcome =
  | "dispatched"
  | "skipped"
  | "failed"
  | "retry"
  | "deferred";

/** 源提交（两类统一视图）。 */
export interface DispatchSource {
  id: string;
  problem_id: string;
  user_id: string;
  language: string;
  code: string;
  file_name: string | null;
  contest_id: string | null;
  active_attempt_id: string | null;
  artifact_storage_url: string | null;
  submitted_version_id: string | null;
  /** 客观题原始答案（升级时原样复制到新提交；重判永不改写它）。 */
  answers: Record<string, unknown> | null;
}

/** 读取源提交；已删除返回 null。 */
async function loadSource(
  item: ClaimedJobItem,
): Promise<DispatchSource | null> {
  const db = getDb();
  if (item.source_kind === "submission") {
    const [row] = await db.select({
      id: submissions.id,
      problem_id: submissions.problem_id,
      user_id: submissions.user_id,
      language: submissions.language,
      code: submissions.code,
      file_name: submissions.file_name,
      contest_id: submissions.contest_id,
      active_attempt_id: submissions.active_attempt_id,
      artifact_storage_url: submissions.artifact_storage_url,
      submitted_version_id: submissions.submitted_version_id,
    }).from(submissions).where(eq(submissions.id, item.source_id)).limit(1);
    return row ? { ...row, answers: null } : null;
  }
  const [row] = await db.select({
    id: objectiveSubmissions.id,
    problem_id: objectiveSubmissions.paper_id,
    user_id: objectiveSubmissions.user_id,
    language: objectiveSubmissions.submission_type,
    code: objectiveSubmissions.answers as never,
    file_name: objectiveSubmissions.paper_id,
    contest_id: objectiveSubmissions.contest_id,
    active_attempt_id: objectiveSubmissions.active_attempt_id,
    submitted_version_id: objectiveSubmissions.submitted_version_id,
    answers: objectiveSubmissions.answers,
  }).from(objectiveSubmissions).where(
    eq(objectiveSubmissions.id, item.source_id),
  ).limit(1);
  if (!row) return null;
  return {
    id: row.id,
    problem_id: row.problem_id,
    user_id: row.user_id,
    language: "objective",
    code: "",
    file_name: null,
    contest_id: row.contest_id,
    active_attempt_id: row.active_attempt_id,
    artifact_storage_url: null,
    submitted_version_id: row.submitted_version_id,
    answers: (row.answers ?? {}) as Record<string, unknown>,
  };
}

/** 升级上下文：`source_contest` 时新提交仍需留在原竞赛内（与受理侧同名词区分）。 */
export type JobUpgradeContext = "practice" | "source_contest";

/**
 * 读取重派目标尝试（含冻结快照，用于"只续签凭据、不重解析默认配置"）。
 */
async function loadAttemptWithSnapshot(
  attemptId: string,
): Promise<typeof evaluationAttempts.$inferSelect | null> {
  const [row] = await getDb().select().from(evaluationAttempts).where(
    eq(evaluationAttempts.id, attemptId),
  ).limit(1);
  return row ?? null;
}

/**
 * 锁内复查**客观题源**（复审问题 8）。
 *
 * 与普通提交一致：命中源已删除 / 仍在评测时抛统一稳定原因码，由派发层映射为
 * `skipped`（而不是被外层 `<500` 分支记成 failed、或退化成 retry）。必须在
 * `objective_submissions` 源行锁内调用，消灭"预检时源还在、锁内已被删除"的窗口。
 */
async function assertObjectiveSourceDispatchable(
  executor: Executor,
  sourceId: string,
): Promise<void> {
  const [row] = await executor.select({
    active: objectiveSubmissions.active_attempt_id,
  }).from(objectiveSubmissions).where(
    eq(objectiveSubmissions.id, sourceId),
  ).for("update");
  if (!row) throw new AppError("源提交已删除", 409, "SOURCE_DELETED");
  if (row.active) {
    const active = await getAttempt(row.active, executor);
    if (active && !isTerminalAttemptState(active.state)) {
      throw new AppError("源提交正在评测", 409, "SOURCE_JUDGING");
    }
  }
}

/** 源竞争（已删除/正在评测）的统一 skipped 收尾。 */
async function completeSourceContention(
  item: ClaimedJobItem,
  owner: string,
  err: unknown,
): Promise<"skipped" | null> {
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
  return null;
}

/**
 * 派发单个已领取条目。
 *
 * @param owner 本 worker 实例标识（lease 归属）
 */
export async function dispatchJobItem(
  item: ClaimedJobItem,
  owner: string,
  jobKind: "rejudge" | "upgrade",
  upgradeContext: JobUpgradeContext = "practice",
  /**
   * 升级额度消费者（缺省 = Redis 实现）。**仅用于测试注入**：额度实现只访问
   * Redis，而 `REDIS_URL` 是进程级变量，测试并行时伪造 URL 的窗口会让其他文件
   * 的额度调用 fail-closed；注入替代实现可隔离验证「额度不足 → 延期」映射。
   */
  quotaConsumer: UpgradeQuotaConsumer = defaultUpgradeQuotaConsumer,
): Promise<DispatchOutcome> {
  if (!await renewJobItemLease(item.id, owner)) return "deferred";
  // §5.7「执行期间续租」：单次派发含支持包下载、LLM token 签发与 MQ 推送等长 IO，
  // 仅在开始时续租一次会让 lease 中途过期，另一个 worker 遂重复领取同一条目。
  const heartbeat = startJobItemLeaseHeartbeat(item.id, owner);
  try {
    return await dispatchClaimedJobItem(
      item,
      owner,
      jobKind,
      upgradeContext,
      quotaConsumer,
    );
  } finally {
    heartbeat.stop();
  }
}

/** 派发主体（调用方已持有有效 lease 并启动续租心跳）。 */
async function dispatchClaimedJobItem(
  item: ClaimedJobItem,
  owner: string,
  jobKind: "rejudge" | "upgrade",
  upgradeContext: JobUpgradeContext,
  quotaConsumer: UpgradeQuotaConsumer,
): Promise<DispatchOutcome> {
  const source = await loadSource(item);
  if (!source) {
    await completeJobItem(item.id, {
      leaseOwner: owner,
      status: "skipped",
      reasonCode: "SOURCE_DELETED",
      reasonMessage: "源提交已删除，跳过该条目",
    });
    return "skipped";
  }

  if (jobKind === "upgrade" && !item.attempt_id) {
    await assertUpgradeAccess(item, source, upgradeContext);
  }

  // 源正在评测 → 跳过，允许之后重试（此时创建新尝试会与在途执行争抢
  // `active_attempt_id`，且历史上已有判定不会被覆盖，重测可稍后重来）
  if (
    source.active_attempt_id && source.active_attempt_id !== item.attempt_id
  ) {
    await completeJobItem(item.id, {
      leaseOwner: owner,
      status: "skipped",
      reasonCode: "SOURCE_JUDGING",
      reasonMessage: "源提交正在评测，稍后可重试",
    });
    return "skipped";
  }

  // 目标版本固定（受理时解析）
  if (!item.target_version_id) {
    await completeJobItem(item.id, {
      leaseOwner: owner,
      status: "skipped",
      reasonCode: "LEGACY_VERSION_UNKNOWN",
      reasonMessage: "提交时版本不可考（历史未知版本），无法按提交时版本重测",
    });
    return "skipped";
  }
  const loaded = await loadPublishedVersionContent(
    item.problem_id,
    item.target_version_id,
  );
  if (!loaded) {
    await completeJobItem(item.id, {
      leaseOwner: owner,
      status: "failed",
      reasonCode: "TARGET_VERSION_MISSING",
      reasonMessage: `目标版本不存在或未发布：${
        item.target_version_ref ?? item.target_version_id
      }`,
    });
    return "failed";
  }
  const content = loaded.content;

  // 客观题版本：只服务客观题提交；判卷是纯函数，直接按目标版本快照处理（无 MQ）
  if (content.kind === "objective") {
    if (item.source_kind !== "objective") {
      await completeJobItem(item.id, {
        leaseOwner: owner,
        status: "failed",
        reasonCode: "CONTENT_KIND_MISMATCH",
        reasonMessage: "代码提交不能使用客观题版本重测",
      });
      return "failed";
    }
    if (jobKind === "upgrade") {
      if (upgradeContext === "source_contest") {
        await completeJobItem(item.id, {
          leaseOwner: owner,
          status: "failed",
          reasonCode: "OBJECTIVE_CONTEST_UPGRADE_FORBIDDEN",
          reasonMessage: "客观题竞赛仅允许一次提交，请选择练习升级或管理员重测",
        });
        return "failed";
      }
      if (source.submitted_version_id === item.target_version_id) {
        await completeJobItem(item.id, {
          leaseOwner: owner,
          status: "skipped",
          reasonCode: "ALREADY_LATEST",
          reasonMessage: "原提交已在目标版本，无需升级",
        });
        return "skipped";
      }
      return await dispatchObjectiveUpgrade({
        item,
        source,
        targetVersionId: item.target_version_id,
        owner,
        quotaConsumer,
      });
    }
    const { rejudgeObjectiveSubmissionForJob } = await import(
      "../../../objective/index.ts"
    );
    // 闭包内无法保留 `item` 的可空收窄，先固化为非空局部量
    const objectiveTargetVersionId = item.target_version_id;
    try {
      // 重判与源行锁复查放在同一事务：锁内发现源已删除/正在评测 → skipped（#8）
      await getDb().transaction(async (tx) => {
        // Handbook §5.1：先锁题库与竞赛宿主，再锁客观题提交行。
        // 与策略切换重算保持相同的 host → source 顺序，避免双方互等。
        await lockProjectionHosts(tx, {
          kind: "objective",
          id: source.id,
          problem_id: source.problem_id,
          contest_id: source.contest_id,
        });
        await assertObjectiveSourceDispatchable(tx, source.id);
        const result = await rejudgeObjectiveSubmissionForJob({
          submissionId: source.id,
          targetVersionId: objectiveTargetVersionId,
          jobKind: "rejudge",
          jobItemId: item.id,
          leaseOwner: owner,
        }, tx);
        await completeJobItem(item.id, {
          leaseOwner: owner,
          status: "succeeded",
          attemptId: result.attempt_id,
          reasonMessage: "客观题按目标版本快照重判完成",
        }, tx);
      });
      return "dispatched";
    } catch (err) {
      const contended = await completeSourceContention(item, owner, err);
      if (contended) return contended;
      logger.error("客观题重判失败", { item_id: item.id, err });
      await scheduleDispatchRetryOrFail(item.id, {
        leaseOwner: owner,
        reasonCode: "OBJECTIVE_REGRADE_FAILED",
        reasonMessage: err instanceof Error ? err.message : String(err),
      });
      return "retry";
    }
  }

  // 走到这里 content 必为 ai/oi，源必须是普通提交
  if (item.source_kind === "objective") {
    await completeJobItem(item.id, {
      leaseOwner: owner,
      status: "failed",
      reasonCode: "CONTENT_KIND_MISMATCH",
      reasonMessage: "客观题提交不能使用代码题版本",
    });
    return "failed";
  }

  // 交付物存在性复检：对象可能已被清理，属永久失败，保留历史判定
  let artifactByteSize: number | null = null;
  if (source.artifact_storage_url) {
    const storage = await getStorageProvider();
    const stat = await storage.stat(source.artifact_storage_url);
    if (!stat.exists) {
      await completeJobItem(item.id, {
        leaseOwner: owner,
        status: "failed",
        reasonCode: "ARTIFACT_MISSING",
        reasonMessage: "产物对象已不存在，保留历史判定",
      });
      return "failed";
    }
    artifactByteSize = stat.sizeBytes;
    // 下载地址在派发阶段重新签发（重派允许换凭据，但不改目标版本）
  }

  // 执行前预检（#33、§7、§5.4 第 1 步）：**提交模式/语言被目标版本接受、
  // 平台镜像仍在当前白名单、资源上限、版本级产物大小上限**统一复用
  // `assertExecutionPreflight`，与初次提交同一套校验。必须在**创建尝试之前**
  // 完成——预检失败属永久失败（带稳定原因码），不得留下无消息的活动尝试，
  // 也不得静默降级执行（如换镜像/去掉 LLM）。
  try {
    await assertExecutionPreflight(content, {
      language: source.language,
      submissionMode: source.artifact_storage_url
        ? "artifact"
        : submissionModeForLanguage(source.language),
      artifactMaxSizeMb: content.kind === "ai"
        ? content.artifact_max_size_mb
        : null,
      artifactByteSize,
    });
  } catch (err) {
    await completeJobItem(item.id, {
      leaseOwner: owner,
      status: "failed",
      reasonCode: err instanceof AppError
        ? err.code
        : "PLATFORM_PREFLIGHT_FAILED",
      reasonMessage: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }

  // 升级：先在目标版本上创建**新提交**（沿用原用户、记录升级来源、使用当前时间），
  // 再对新提交派发评测；原提交与原成绩完全不动（Handbook §4.4）
  if (jobKind === "upgrade") {
    if (source.submitted_version_id === item.target_version_id) {
      await completeJobItem(item.id, {
        leaseOwner: owner,
        status: "skipped",
        reasonCode: "ALREADY_LATEST",
        reasonMessage:
          "原提交已在目标版本，无需升级（再次评测请使用管理员重测）",
      });
      return "skipped";
    }
    return await dispatchCodeUpgrade({
      item,
      owner,
      source,
      content,
      upgradeContext,
      quotaConsumer,
    });
  }

  return await dispatchJudgeAttempt({
    item,
    owner,
    attemptSource: {
      kind: "submission",
      id: source.id,
      problem_id: source.problem_id,
      contest_id: source.contest_id,
    },
    submissionId: source.id,
    source,
    content,
    sourceKind: "rejudge",
    priority: "low",
    quotaConsumer,
  });
}

/** 派发一次 Judge 执行（重测与升级共用）。 */
async function dispatchJudgeAttempt(input: {
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
      runtime_config: content.runtime_config,
      download_url: downloadUrl,
      artifact_download_url: artifactDownloadUrl,
      language: source.language,
      code: source.artifact_storage_url ? "" : source.code,
      file_name: source.file_name ?? undefined,
      llm: llmTask,
    });

    // 完整非敏感快照（排除源码、短期下载地址与 token）：事务内与尝试一同落库
    const prepared: PreparedJobExecution = {
      attemptId,
      destinationId,
      taskSnapshot: {
        ...executionSnapshot(task, llmConfig, previousSnapshot),
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
 * 客观题升级：创建新的**练习**提交并同步重判。
 *
 * 客观题竞赛只允许一次提交，因此升级一律落练习提交（原竞赛提交仍可被管理员重测）；
 * 新提交记录 `upgraded_from_id` 并使用当前时间。
 */
async function dispatchObjectiveUpgrade(input: {
  item: ClaimedJobItem;
  source: DispatchSource;
  targetVersionId: string;
  owner: string;
  quotaConsumer: UpgradeQuotaConsumer;
}): Promise<DispatchOutcome> {
  const { item, source, targetVersionId, owner } = input;
  const db = getDb();
  const { rejudgeObjectiveSubmissionForJob } = await import(
    "../../../objective/index.ts"
  );
  try {
    await db.transaction(async (tx) => {
      // Handbook §5.1：先锁来源题库与竞赛，再锁客观题源行；随后才能创建副本、
      // 分配 revision 并创建新尝试。策略重算使用同一宿主 → 来源提交顺序。
      await lockProjectionHosts(tx, {
        kind: "objective",
        id: source.id,
        problem_id: source.problem_id,
        contest_id: source.contest_id,
      });
      // 锁内复查源：预检期间被删除/换活动尝试 → skipped（#8），且不留副本
      await assertObjectiveSourceDispatchable(tx, source.id);
      const newId = crypto.randomUUID();
      await tx.insert(objectiveSubmissions).values({
        id: newId,
        paper_id: source.problem_id,
        user_id: source.user_id,
        contest_id: null,
        submission_type: "practice",
        answers: source.answers ?? {},
        status: "finished",
        score: 0,
        details: {},
        submitted_version_id: targetVersionId,
        version_origin: "known",
        upgraded_from_id: source.id,
        created_at: new Date().toISOString(),
      });
      // #6：新增正式提交（含客观题升级副本）必须递增实际提交数 revision
      await bumpSubmissionCountRevisions(tx, {
        problem_id: source.problem_id,
        contest_id: null,
      });
      // #9：升级副本占用原用户正常提交额度（幂等标识 = job item）
      // 客观题副本必须占用**客观题**额度桶（复审问题 6）
      await consumeUpgradeQuota(
        tx,
        source.user_id,
        item.id,
        "objective",
        input.quotaConsumer,
      );
      await tx.update(submissionJobItems).set({ result_submission_id: newId })
        .where(eq(submissionJobItems.id, item.id));
      await rejudgeObjectiveSubmissionForJob({
        submissionId: newId,
        targetVersionId,
        jobKind: "upgrade",
        jobItemId: item.id,
        leaseOwner: input.owner,
      }, tx);
    });
    return "dispatched";
  } catch (err) {
    // 额度不足同样属"延期"：本事务已回滚（不发新提交），条目可重试
    if (err instanceof UpgradeQuotaDeferredError) {
      await requeueJobItem(
        item.id,
        Math.max(1, Math.ceil(err.retryAfterMs / 1000)),
        owner,
      );
      return "deferred";
    }
    // 源竞争（已删除/正在评测）→ skipped，与普通提交分类一致（#8）
    const contended = await completeSourceContention(item, owner, err);
    if (contended) return contended;
    logger.error("客观题升级失败", { item_id: item.id, err });
    await scheduleDispatchRetryOrFail(item.id, {
      leaseOwner: owner,
      reasonCode: "UPGRADE_FAILED",
      reasonMessage: err instanceof Error ? err.message : String(err),
    });
    return "retry";
  }
}

/**
 * 代码/产物升级：创建新提交（沿用原用户与原始代码/产物，记录升级来源、使用当前
 * 时间；`context = source_contest` 时保留原竞赛），再对新提交派发评测。
 */
async function dispatchCodeUpgrade(input: {
  item: ClaimedJobItem;
  owner: string;
  source: DispatchSource;
  content: Exclude<ProblemContentV1, { kind: "objective" }>;
  upgradeContext: JobUpgradeContext;
  quotaConsumer: UpgradeQuotaConsumer;
}): Promise<DispatchOutcome> {
  const { item, owner, source, content, upgradeContext } = input;
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
  });
}

/**
 * 执行一轮 worker：回收过期 lease → 领取 → 逐条派发 → 聚合任务状态。
 *
 * 返回本轮统计，便于测试与日志。
 */
export async function runSubmissionJobWorkerOnce(
  owner: string,
  options: { limit?: number } = {},
): Promise<{
  claimed: number;
  dispatched: number;
  skipped: number;
  failed: number;
  retry: number;
  deferred: number;
}> {
  const { claimJobItems, requeueExpiredLeases, findJobById } = await import(
    "./job-worker.ts"
  );
  await requeueExpiredLeases();
  const leaseOwner = `${owner}-${crypto.randomUUID()}`;
  const stats = {
    claimed: 0,
    dispatched: 0,
    skipped: 0,
    failed: 0,
    retry: 0,
    deferred: 0,
  };
  const touchedJobs = new Set<string>();
  // 一次只领取即将处理的条目，避免一批慢任务让后面的租约在开始前过期。
  const limit = Math.max(0, Math.min(options.limit ?? 100, 100));
  for (let index = 0; index < limit; index++) {
    const [item] = await claimJobItems(leaseOwner, { limit: 1 });
    if (!item) break;
    stats.claimed++;
    touchedJobs.add(item.job_id);
    let outcome: DispatchOutcome;
    try {
      const job = await findJobById(item.job_id);
      const requestContext = (job?.request as { context?: string } | null)
        ?.context;
      outcome = await dispatchJobItem(
        item,
        leaseOwner,
        job?.kind === "upgrade" ? "upgrade" : "rejudge",
        requestContext === "source_contest" ? "source_contest" : "practice",
      );
    } catch (err) {
      logger.error("批任务条目派发异常", { item_id: item.id, err });
      if (err instanceof AppError && err.code === "JOB_LEASE_LOST") {
        stats.deferred++;
        continue;
      }
      // #9：额度不足属"延期"（可重试、不计失败、不发新提交）
      if (err instanceof UpgradeQuotaDeferredError) {
        await requeueJobItem(
          item.id,
          Math.max(1, Math.ceil(err.retryAfterMs / 1000)),
          leaseOwner,
        );
        stats.deferred++;
        continue;
      }
      // #10：锁内复查发现的"源正在评测 / 源已删除"属 Handbook 固定分类的
      // **skipped**（可重试），不是配置/交付物错误，不能记 failed。
      if (
        err instanceof AppError &&
        (err.code === "SOURCE_JUDGING" || err.code === "SOURCE_DELETED")
      ) {
        await completeJobItem(item.id, {
          leaseOwner,
          status: "skipped",
          reasonCode: err.code,
          reasonMessage: err.message,
        });
        stats.skipped++;
        continue;
      }
      if (err instanceof AppError && err.statusCode < 500) {
        await completeJobItem(item.id, {
          leaseOwner,
          status: "failed",
          reasonCode: err.code,
          reasonMessage: err.message,
        });
        stats.failed++;
        continue;
      }
      await scheduleDispatchRetryOrFail(item.id, {
        leaseOwner,
        reasonCode: "DISPATCH_EXCEPTION",
        reasonMessage: err instanceof Error ? err.message : String(err),
      });
      outcome = "retry";
    }
    if (outcome === "dispatched") stats.dispatched++;
    else if (outcome === "skipped") stats.skipped++;
    else if (outcome === "failed") stats.failed++;
    else if (outcome === "retry") stats.retry++;
    else stats.deferred++;
  }
  for (const jobId of touchedJobs) {
    await refreshJobStatus(jobId);
  }
  return stats;
}

/** worker 轮询间隔（毫秒）。 */
export const SUBMISSION_JOB_WORKER_INTERVAL_MS = 3000;

/** worker 句柄（单进程一个；多副本靠 SKIP LOCKED 与 lease 协调，无共享内存依赖）。 */
let _jobWorkerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动批量任务 worker（幂等）。
 *
 * 多副本安全：条目领取使用 `FOR UPDATE SKIP LOCKED` + lease，实例标识仅用于
 * 续租归属；进程内只保存定时器句柄，不保存任何业务状态。
 */
export function startSubmissionJobWorker(): void {
  if (_jobWorkerTimer !== null) return;
  const owner = `noj-core-${crypto.randomUUID()}`;
  logger.info("批任务 worker 已启动", {
    interval_ms: SUBMISSION_JOB_WORKER_INTERVAL_MS,
  });
  _jobWorkerTimer = setInterval(() => {
    void runSubmissionJobWorkerOnce(owner).catch((err) => {
      logger.error("批任务 worker 执行失败", { err });
    });
  }, SUBMISSION_JOB_WORKER_INTERVAL_MS);
}

/** 停止 worker（关闭流程用）。 */
export function stopSubmissionJobWorker(): void {
  if (_jobWorkerTimer === null) return;
  clearInterval(_jobWorkerTimer);
  _jobWorkerTimer = null;
}
