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
import {
  objectiveSubmissions,
  problemVersionObjects,
  submissionJobItems,
  submissions,
} from "../../../../shared/db/schema.ts";
import { getLogger } from "@logtape/logtape";
import { generatePublicId } from "../../../../shared/security/public-id.ts";
import { getStorageProvider } from "../../../system/index.ts";
import type { LlmConfig } from "../../../catalog/index.ts";
import type { ProblemContentV1 } from "../../../catalog/index.ts";
import { buildJudgeTaskLlm } from "../../../gateway/index.ts";
import {
  isRetryableJudgeQueueError,
  pushJudgeTask,
} from "../../mq/producer.ts";
import { prepareJudgeTask } from "../prepare-judge-task.ts";
import { createAttempt } from "./attempts.ts";
import {
  type ClaimedJobItem,
  completeJobItem,
  markJobItemDispatched,
  renewJobItemLease,
  requeueJobItem,
  scheduleDispatchRetryOrFail,
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
interface DispatchSource {
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

/** 版本文件引用中的支持包下载地址。 */
async function resolveVersionSupportPackage(
  versionId: string,
): Promise<string | undefined> {
  const db = getDb();
  const [ref] = await db.select({
    storage_url: problemVersionObjects.storage_url,
  }).from(problemVersionObjects).where(
    and(
      eq(problemVersionObjects.version_id, versionId),
      eq(problemVersionObjects.role, "support_package"),
    ),
  ).limit(1);
  if (!ref?.storage_url) return undefined;
  const storage = await getStorageProvider();
  return await storage.downloadUrl(ref.storage_url);
}

/** 目标版本是否接受该语言的源码提交（OI/dual 一致口径）。 */
function languageAccepted(
  content: ProblemContentV1,
  language: string,
): boolean {
  if (content.kind !== "oi") return true;
  return content.runtime_config.languages.includes(language as "c" | "cc");
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
): Promise<DispatchOutcome> {
  const source = await loadSource(item);
  if (!source) {
    await completeJobItem(item.id, {
      status: "skipped",
      reasonCode: "SOURCE_DELETED",
      reasonMessage: "源提交已删除，跳过该条目",
    });
    return "skipped";
  }

  // 源正在评测 → 跳过，允许之后重试（此时创建新尝试会与在途执行争抢
  // `active_attempt_id`，且历史上已有判定不会被覆盖，重测可稍后重来）
  if (source.active_attempt_id) {
    await completeJobItem(item.id, {
      status: "skipped",
      reasonCode: "SOURCE_JUDGING",
      reasonMessage: "源提交正在评测，稍后可重试",
    });
    return "skipped";
  }

  // 目标版本固定（受理时解析）
  if (!item.target_version_id) {
    await completeJobItem(item.id, {
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
        status: "failed",
        reasonCode: "CONTENT_KIND_MISMATCH",
        reasonMessage: "代码提交不能使用客观题版本重测",
      });
      return "failed";
    }
    if (jobKind === "upgrade") {
      if (source.submitted_version_id === item.target_version_id) {
        await completeJobItem(item.id, {
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
      });
    }
    const { rejudgeObjectiveSubmissionForJob } = await import(
      "../../../objective/index.ts"
    );
    try {
      const result = await rejudgeObjectiveSubmissionForJob({
        submissionId: source.id,
        targetVersionId: item.target_version_id,
        jobKind: "rejudge",
      });
      await completeJobItem(item.id, {
        status: "succeeded",
        attemptId: result.attempt_id,
        reasonMessage: "客观题按目标版本快照重判完成",
      });
      return "dispatched";
    } catch (err) {
      logger.error("客观题重判失败", { item_id: item.id, err });
      await scheduleDispatchRetryOrFail(item.id, {
        reasonCode: "OBJECTIVE_REGRADE_FAILED",
        reasonMessage: err instanceof Error ? err.message : String(err),
      });
      return "retry";
    }
  }

  // 走到这里 content 必为 ai/oi，源必须是普通提交
  if (item.source_kind === "objective") {
    await completeJobItem(item.id, {
      status: "failed",
      reasonCode: "CONTENT_KIND_MISMATCH",
      reasonMessage: "客观题提交不能使用代码题版本",
    });
    return "failed";
  }

  // 语言与交付物复检
  if (!languageAccepted(content, source.language)) {
    await completeJobItem(item.id, {
      status: "failed",
      reasonCode: "LANGUAGE_NOT_SUPPORTED",
      reasonMessage: `原语言 ${source.language} 不在目标版本允许列表`,
    });
    return "failed";
  }

  if (source.artifact_storage_url) {
    const storage = await getStorageProvider();
    const stat = await storage.stat(source.artifact_storage_url).catch(() => ({
      exists: false,
      sizeBytes: null,
      lastModified: null,
    }));
    if (!stat.exists) {
      await completeJobItem(item.id, {
        status: "failed",
        reasonCode: "ARTIFACT_MISSING",
        reasonMessage: "产物对象已不存在，保留历史判定",
      });
      return "failed";
    }
    const limitMb = content.kind === "ai" ? content.artifact_max_size_mb : null;
    if (
      limitMb !== null && limitMb !== undefined && stat.sizeBytes !== null &&
      stat.sizeBytes > limitMb * 1024 * 1024
    ) {
      await completeJobItem(item.id, {
        status: "failed",
        reasonCode: "ARTIFACT_TOO_LARGE_FOR_VERSION",
        reasonMessage:
          `原产物 ${stat.sizeBytes} 字节超过目标版本上限 ${limitMb}MB`,
      });
      return "failed";
    }
    // 下载地址在派发阶段重新签发（重派允许换凭据，但不改目标版本）
  }

  // 升级：先在目标版本上创建**新提交**（沿用原用户、记录升级来源、使用当前时间），
  // 再对新提交派发评测；原提交与原成绩完全不动（Handbook §4.4）
  if (jobKind === "upgrade") {
    if (source.submitted_version_id === item.target_version_id) {
      await completeJobItem(item.id, {
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
  source: DispatchSource;
  content: Exclude<ProblemContentV1, { kind: "objective" }>;
  sourceKind: "rejudge" | "upgrade";
  priority: "low" | "medium";
}): Promise<DispatchOutcome> {
  const { item, owner, source, content, submissionId } = input;
  const targetVersionId = item.target_version_id as string;

  // 创建新尝试：sequence 递增、绑定目标版本，旧尝试与历史判定全部保留
  const attempt = await createAttempt({
    source: input.attemptSource,
    problemVersionId: targetVersionId,
    source_kind: input.sourceKind,
    taskSnapshot: {
      language: source.language,
      problem_version_id: targetVersionId,
      submission_mode: content.kind === "ai" ? content.submission_mode : "code",
      batch_job_id: item.job_id,
    },
    createdBy: null,
  });

  let artifactDownloadUrl: string | undefined;
  if (source.artifact_storage_url) {
    const storage = await getStorageProvider();
    artifactDownloadUrl = await storage.downloadUrl(
      source.artifact_storage_url,
    );
  }

  let llmTask;
  const llmConfig = content.kind === "ai"
    ? (content.llm_config as LlmConfig | null)
    : null;
  if (llmConfig && content.kind === "ai") {
    llmTask = await buildJudgeTaskLlm(
      llmConfig,
      submissionId,
      source.problem_id,
      source.user_id,
      content.runtime_config,
      {
        // 同一尝试重派共享预算：重新签发 token 不重置额度
        attemptId: attempt.id,
        problemVersionId: targetVersionId,
      },
    );
  }

  const task = await prepareJudgeTask({
    attempt_id: attempt.id,
    problem_version_id: targetVersionId,
    submission_id: submissionId,
    problem_id: source.problem_id,
    user_id: source.user_id,
    priority: input.priority,
    runtime_config: content.runtime_config,
    download_url: await resolveVersionSupportPackage(targetVersionId),
    artifact_download_url: artifactDownloadUrl,
    language: source.language,
    code: source.artifact_storage_url ? "" : source.code,
    file_name: source.file_name ?? undefined,
    llm: llmTask,
  });

  // 续租后再派发：长任务不会因 lease 过期被其他 worker 重复领取
  await renewJobItemLease(item.id, owner);

  try {
    await pushJudgeTask(task);
  } catch (err) {
    if (isRetryableJudgeQueueError(err)) {
      // 容量不足属"稍后重试"，不计失败（退避计数不动）
      await requeueJobItem(item.id);
      return "deferred";
    }
    await scheduleDispatchRetryOrFail(item.id, {
      reasonCode: "DISPATCH_FAILED",
      reasonMessage: err instanceof Error ? err.message : String(err),
    });
    return "retry";
  }

  await markJobItemDispatched(item.id, attempt.id, owner);
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
}): Promise<DispatchOutcome> {
  const { item, source, targetVersionId } = input;
  const db = getDb();
  const newId = crypto.randomUUID();
  await db.insert(objectiveSubmissions).values({
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
  try {
    const { rejudgeObjectiveSubmissionForJob } = await import(
      "../../../objective/index.ts"
    );
    const result = await rejudgeObjectiveSubmissionForJob({
      submissionId: newId,
      targetVersionId,
      jobKind: "upgrade",
    });
    await completeJobItem(item.id, {
      status: "succeeded",
      attemptId: result.attempt_id,
      reasonMessage: "已按目标版本生成客观题升级提交",
    });
    await db.update(submissionJobItems).set({ result_submission_id: newId })
      .where(eq(submissionJobItems.id, item.id));
    return "dispatched";
  } catch (err) {
    // 升级失败不留"无评测"的新提交
    await db.delete(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, newId),
    );
    logger.error("客观题升级失败", { item_id: item.id, err });
    await scheduleDispatchRetryOrFail(item.id, {
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
}): Promise<DispatchOutcome> {
  const { item, owner, source, content, upgradeContext } = input;
  const db = getDb();
  const targetVersionId = item.target_version_id as string;
  const newId = crypto.randomUUID();
  await db.insert(submissions).values({
    id: newId,
    public_id: generatePublicId("sub"),
    user_id: source.user_id,
    problem_id: source.problem_id,
    contest_id: upgradeContext === "source_contest" ? source.contest_id : null,
    language: source.language,
    code: source.code,
    file_name: source.file_name,
    artifact_storage_url: source.artifact_storage_url,
    status: "pending",
    submitted_version_id: targetVersionId,
    version_origin: "known",
    upgraded_from_id: source.id,
    created_at: new Date().toISOString(),
  });

  const outcome = await dispatchJudgeAttempt({
    item,
    owner,
    attemptSource: {
      kind: "submission",
      id: newId,
      problem_id: source.problem_id,
      contest_id: upgradeContext === "source_contest"
        ? source.contest_id
        : null,
    },
    submissionId: newId,
    source,
    content,
    sourceKind: "upgrade",
    priority: "medium",
  });

  if (outcome === "dispatched") {
    // 与正常提交同一口径：入队成功后置 judging（条件更新，结果早到不回退终态）
    await db.update(submissions).set({ status: "judging" }).where(
      and(eq(submissions.id, newId), eq(submissions.status, "pending")),
    );
  }
  if (outcome === "dispatched" || outcome === "deferred") {
    await db.update(submissionJobItems).set({ result_submission_id: newId })
      .where(eq(submissionJobItems.id, item.id));
  } else {
    // 派发失败：删除新提交，避免留下永远 pending 的孤儿
    await db.delete(submissions).where(eq(submissions.id, newId));
  }
  return outcome;
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
  const items = await claimJobItems(owner, options);
  const stats = {
    claimed: items.length,
    dispatched: 0,
    skipped: 0,
    failed: 0,
    retry: 0,
    deferred: 0,
  };
  const touchedJobs = new Set<string>();
  for (const item of items) {
    touchedJobs.add(item.job_id);
    let outcome: DispatchOutcome;
    try {
      const job = await findJobById(item.job_id);
      const requestContext = (job?.request as { context?: string } | null)
        ?.context;
      outcome = await dispatchJobItem(
        item,
        owner,
        job?.kind === "upgrade" ? "upgrade" : "rejudge",
        requestContext === "source_contest" ? "source_contest" : "practice",
      );
    } catch (err) {
      logger.error("批任务条目派发异常", { item_id: item.id, err });
      await scheduleDispatchRetryOrFail(item.id, {
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
