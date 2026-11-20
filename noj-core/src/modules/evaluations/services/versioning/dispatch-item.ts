// 批量任务条目派发主流程（dispatchJobItem 与源/版本/交付物复检分类编排）。
import { getStorageProvider } from "../../../assets/storage/mod.ts";
import { submissionModeForLanguage } from "../../types/ui-solution.ts";
import { assertUpgradeAccess } from "./upgrade-access.ts";
import { assertDomainJobExecution } from "./domain-job-access.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import { assertExecutionPreflight } from "./version-execution.ts";
import {
  type ClaimedJobItem,
  completeJobItem,
  renewJobItemLease,
  startJobItemLeaseHeartbeat,
} from "./job-worker.ts";
import { loadPublishedVersionContent } from "./submission-version.ts";
import { loadSource } from "./dispatch-source.ts";
import {
  dispatchObjectiveRejudge,
  dispatchObjectiveUpgrade,
} from "./dispatch-objective.ts";
import {
  dispatchCodeUpgrade,
  dispatchJudgeAttempt,
} from "./dispatch-attempt.ts";
import type {
  DispatchOutcome,
  JobUpgradeContext,
  LeaseGate,
} from "./dispatch-types.ts";
import {
  defaultUpgradeQuotaConsumer,
  type UpgradeQuotaConsumer,
} from "./job-attempt.ts";

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
  const lease: LeaseGate = { assertHeld: () => heartbeat.assertHeld() };
  try {
    return await dispatchClaimedJobItem(
      item,
      owner,
      jobKind,
      upgradeContext,
      quotaConsumer,
      lease,
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
  lease: LeaseGate,
): Promise<DispatchOutcome> {
  const input = { lease };
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

  if (!item.attempt_id) {
    await assertDomainJobExecution(item, source, jobKind);
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
        lease: input.lease,
      });
    }
    return await dispatchObjectiveRejudge({
      item,
      owner,
      source,
      targetVersionId: item.target_version_id,
    });
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
      // 上传文件提交的具体模式（artifact / prediction）取自题目提交模式：
      // 发布后不可变，因此源提交与目标版本同属一种上传模式。
      submissionMode: source.artifact_storage_url
        ? (content.kind === "ai" && content.submission_mode === "prediction"
          ? "prediction"
          : "artifact")
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
      lease: input.lease,
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
    lease: input.lease,
  });
}
