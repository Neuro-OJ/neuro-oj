/**
 * 批任务的持久化执行分配：领取者、提交副本与尝试的关联必须在入队前原子提交。
 *
 * 顺序契约（#7）：**先**在工作流外完成目标执行上下文的全部准备与预检
 * （支持包存在性、LLM 服务/模型/预算、完整非敏感快照、预先分配的 attempt ID /
 * 副本 ID），**再**在一个事务里创建副本、尝试与条目关联。这样：
 * - Provider 缺配、支持包缺失等永久失败不会留下不该存在的尝试行；
 * - 进程中途崩溃时快照已冻结，恢复只按快照重放，不会重新解析当前默认配置。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  submissionJobItems,
  submissionJobs,
  submissions,
} from "../../../../shared/db/schema.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import { generatePublicId } from "../../../../shared/security/public-id.ts";
import { assertStorageObjectBindable } from "../../../assets/index.ts";
import { resolveSubmissionVersion } from "./submission-version.ts";
import { assertDomainJobExecution } from "./domain-job-access.ts";
import { consumeDomainSubmissionQuota } from "../../../../domains/workspace/index.ts";
import { createAttempt } from "./attempts.ts";
import {
  bumpSubmissionCountRevisions,
  lockProjectionHosts,
} from "./projection.ts";
import type { ClaimedJobItem } from "./job-worker.ts";
import type { DispatchSource, JobUpgradeContext } from "./dispatch-job-item.ts";
import {
  consumeSubmissionQuotaForUpgrade,
  type UpgradeQuotaBucket,
} from "./upgrade-quota.ts";

/**
 * 预先分配并冻结的执行上下文（#7）。
 *
 * 这些值在**进入事务之前**就已确定：attempt ID、升级副本 ID 与完整非敏感执行
 * 快照。事务内只负责落库与关联，不再解析任何"当前默认"配置。
 *
 * **sequence 不在此冻结**（复审问题 1）：它必须在**源提交行锁内**由
 * `createAttempt` 统一分配（`max(MAX(尝试)+1, 源行 rejudge_seq)`），否则存量
 * `legacy_unknown` 提交（无尝试行但 `rejudge_seq=7`）会落库 7、任务封套 0，
 * 结果因 sequence 不匹配被静默丢弃。任务封套一律使用**落库返回的** `attempt.sequence`。
 */
export interface PreparedJobExecution {
  /** 预分配的尝试 ID（= 正式评测 `run_id`）。 */
  attemptId: string;
  /** 重测时等于源提交 ID；升级时是预分配的**新副本** ID。 */
  destinationId: string;
  /** 完整非敏感执行快照（语言、版本、运行配置、LLM provider/model/预算等）。 */
  taskSnapshot: Record<string, unknown>;
}

/** 额度不足导致条目**延期**（#9）：调用方据此 requeue，不得计作失败。 */
export class UpgradeQuotaDeferredError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("原用户提交额度不足，升级条目已延期");
    this.name = "UpgradeQuotaDeferredError";
    // 防御：非有限/非正值一律回退到 60s，避免下游 plusSeconds(NaN) 抛 RangeError。
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : 60_000;
  }
}

/** 域分钟额度不足同样延期，不把可重试的频率限制记录为永久失败。 */
export async function consumeDomainUpgradeQuota(
  domainId: string,
  userId: string,
  itemId: string,
  executor: Executor,
) {
  try {
    await consumeDomainSubmissionQuota(domainId, userId, itemId, executor);
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === "DOMAIN_SUBMISSION_QUOTA_EXCEEDED"
    ) {
      throw new UpgradeQuotaDeferredError(60_000);
    }
    throw error;
  }
}

/**
 * 升级额度消费者签名（幂等标识 = `submission_job_items.id`）。
 *
 * 作为**显式可注入参数**（而非模块内可变状态）暴露：测试需要验证「额度不足 →
 * 条目延期」的映射，但额度实现只访问 Redis，而 `REDIS_URL` 是**进程级**环境变量、
 * 同一分片的测试文件并行执行——任何文件伪造 Redis URL 的窗口都会让其他文件的额度
 * 调用 fail-closed，从而把正常的升级派发误判成延期。注入消费者可以让测试在不污染
 * 全局 Redis 环境的前提下验证该分支，生产路径仍固定使用 Redis 实现（fail-closed）。
 */
export type UpgradeQuotaConsumer = (
  sourceUserId: string,
  jobItemId: string,
  /** 副本实际生成的提交类型对应的额度桶（复审问题 6）。 */
  bucket: UpgradeQuotaBucket,
) => Promise<{ ok: true } | { ok: false; retryAfterMs: number }>;

/**
 * 默认消费者：task-10 的 Redis 额度实现（额度不足或 Redis 不可用 → `ok:false` 延期）。
 *
 * **限流总开关关闭时短路**（开发/测试环境默认关闭，`isRateLimitEnabled()` 见
 * `system/services/rate-limit-env.ts`）：此时不存在提交额度，无需占用幂等占位，
 * 也不必依赖 Redis 可用性——额度实现是 **fail-closed** 的，任何 Redis 抖动都会把
 * 正常的升级派发变成"延期"。该短路与额度实现自身的文档语义一致
 * （"不限流环境直接放行"），只是不再做那次多余的 Redis 往返；
 * **生产（`rate_limit_enabled=true`）仍走真实实现并保持 fail-closed**。
 */
export function defaultUpgradeQuotaConsumer(
  sourceUserId: string,
  jobItemId: string,
  bucket: UpgradeQuotaBucket,
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  // 桶选择必须与"新副本实际生成的提交类型"一致（复审问题 6）：
  // 否则用户可用练习额度跑竞赛升级、或用代码额度跑客观题升级。
  return consumeSubmissionQuotaForUpgrade(sourceUserId, jobItemId, { bucket });
}

/**
 * 消费原用户的正常提交额度（#9，实现见 task-10 的 `upgrade-quota.ts`）。
 *
 * - 幂等标识 = `submission_job_items.id`：重派/重投不重复扣费；
 * - `ok:false` → 抛 `UpgradeQuotaDeferredError`，使**本次事务整体回滚**
 *   （不产生副本与尝试），条目转入延期可重试；
 * - 该 helper 只访问 Redis（额度计数 + 24h 幂等占位），不参与 DB 事务，
 *   因此在本事务内同步调用是安全的；`executor` 参数保留仅为调用点语义统一；
 * - `consumer` 缺省为 Redis 实现；测试可注入替代实现（见 `UpgradeQuotaConsumer`）。
 */
export async function consumeUpgradeQuota(
  _executor: Executor,
  sourceUserId: string,
  jobItemId: string,
  bucket: UpgradeQuotaBucket,
  consumer: UpgradeQuotaConsumer = defaultUpgradeQuotaConsumer,
): Promise<void> {
  const result = await consumer(sourceUserId, jobItemId, bucket);
  if (!result.ok) throw new UpgradeQuotaDeferredError(result.retryAfterMs);
}

/** 读取任务的操作者（管理员代原用户升级时用于记录 actor）。 */
async function jobActorId(
  executor: Executor,
  jobId: string,
): Promise<string | null> {
  const [job] = await executor.select({ actor_id: submissionJobs.actor_id })
    .from(submissionJobs).where(eq(submissionJobs.id, jobId)).limit(1);
  return job?.actor_id ?? null;
}

/** 重试复用原尝试和升级副本；租约已经换主的执行者不能创建任何副作用。 */
export async function ensureJobAttempt(
  input: {
    item: ClaimedJobItem;
    owner: string;
    source: DispatchSource;
    kind: "rejudge" | "upgrade";
    context?: JobUpgradeContext;
    /** 事务外预先准备并冻结的执行上下文（#7）。 */
    prepared: PreparedJobExecution;
  },
  /** 额度消费者（缺省 Redis 实现；测试可注入，见 `UpgradeQuotaConsumer`）。 */
  quotaConsumer: UpgradeQuotaConsumer = defaultUpgradeQuotaConsumer,
): Promise<typeof evaluationAttempts.$inferSelect> {
  const { item, owner, source, kind, prepared } = input;
  return await getDb().transaction(async (tx) => {
    const execution = !item.attempt_id
      ? await assertDomainJobExecution(item, source, kind, tx)
      : null;
    const contestId = kind === "upgrade" && input.context !== "source_contest"
      ? null
      : source.contest_id;
    await lockProjectionHosts(tx, {
      kind: "submission",
      id: source.id,
      problem_id: source.problem_id,
      contest_id: contestId,
    });
    // 在锁内复查源，两个任务争抢同一提交时只允许一个创建在途尝试。
    // `SOURCE_DELETED` / `SOURCE_JUDGING` 属 Handbook 固定分类的 **skipped**
    // （#10），由派发层映射；这里只抛稳定 code。
    const [original] = await tx.select().from(submissions).where(
      eq(submissions.id, source.id),
    ).for("update");
    if (!original) throw new AppError("源提交已删除", 409, "SOURCE_DELETED");
    const [claimed] = await tx.select().from(submissionJobItems).where(
      eq(submissionJobItems.id, item.id),
    ).for("update");
    if (
      !claimed || claimed.status !== "preparing" ||
      claimed.lease_owner !== owner || !claimed.lease_until ||
      claimed.lease_until <= new Date().toISOString()
    ) {
      throw new AppError("任务条目租约已失效", 409, "JOB_LEASE_LOST");
    }
    if (claimed.attempt_id) {
      const [attempt] = await tx.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.id, claimed.attempt_id),
      );
      if (!attempt || attempt.problem_version_id !== item.target_version_id) {
        throw new AppError("尝试关联已失效", 409, "JOB_ATTEMPT_MISSING");
      }
      // 重派/重试：复用既有尝试与副本，不再扣额度、不再递增统计 revision
      return attempt;
    }
    if (original.active_attempt_id) {
      throw new AppError("源提交正在评测", 409, "SOURCE_JUDGING");
    }
    if (kind === "upgrade") {
      await consumeDomainUpgradeQuota(
        execution!.domain_id,
        source.user_id,
        item.id,
        tx,
      );
      if (contestId) {
        await resolveSubmissionVersion(source.problem_id, {
          contestId,
          requestedVersionId: item.target_version_id,
        }, tx);
      }
      if (source.artifact_storage_url) {
        await assertStorageObjectBindable(source.artifact_storage_url, tx);
      }
      // 升级副本使用**预分配**的 ID（副本、尝试、条目关联同一事务落库）
      await tx.insert(submissions).values({
        domain_id: execution!.domain_id,
        domain_problem_binding_id: execution!.domain_problem_binding_id,
        assignment_id: original.assignment_id,
        assignment_item_id: original.assignment_item_id,
        id: prepared.destinationId,
        public_id: generatePublicId("sub"),
        user_id: source.user_id,
        problem_id: source.problem_id,
        contest_id: contestId,
        language: source.language,
        code: source.code,
        file_name: source.file_name,
        artifact_storage_url: source.artifact_storage_url,
        status: "pending",
        submitted_version_id: item.target_version_id,
        version_origin: "known",
        upgraded_from_id: source.id,
        created_at: new Date().toISOString(),
      });
      // #6：新增正式提交必须递增实际提交数相关 revision（题目/竞赛/global），
      // 与普通提交入口同一口径；复用路径上面已提前 return，不会重复递增。
      await bumpSubmissionCountRevisions(tx, {
        problem_id: source.problem_id,
        contest_id: contestId,
      });
      // #9：升级副本占用**原用户**的正常提交额度（幂等标识 = job item）；
      // 额度不足抛 UpgradeQuotaDeferredError → 本事务回滚（不发新提交）。
      // 桶按"新副本实际生成的提交类型"选择：留在原竞赛的升级走竞赛桶，
      // 练习升级走普通代码桶（复审问题 6）。
      const quotaBucket: UpgradeQuotaBucket = input.context === "source_contest"
        ? "contest_code"
        : "code";
      await consumeUpgradeQuota(
        tx,
        source.user_id,
        item.id,
        quotaBucket,
        quotaConsumer,
      );
    }
    const attempt = await createAttempt({
      id: prepared.attemptId,
      source: {
        kind: "submission",
        id: prepared.destinationId,
        problem_id: source.problem_id,
        contest_id: contestId,
      },
      problemVersionId: item.target_version_id,
      source_kind: kind,
      // 事务外已冻结的完整非敏感快照：恢复/重派只依赖它
      taskSnapshot: prepared.taskSnapshot,
      // §4.4：管理员可代原用户升级；新提交归**原用户**，操作者 actor 记录在尝试上。
      createdBy: await jobActorId(tx, item.job_id),
      executor: tx,
    });
    await tx.update(submissionJobItems).set({
      attempt_id: attempt.id,
      ...(kind === "upgrade"
        ? { result_submission_id: prepared.destinationId }
        : {}),
    }).where(eq(submissionJobItems.id, item.id));
    const [stored] = await tx.select().from(evaluationAttempts).where(
      eq(evaluationAttempts.id, attempt.id),
    );
    return stored;
  });
}
