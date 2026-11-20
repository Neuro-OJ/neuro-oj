/** 客观题版本条目的重判派发与升级派发。 */

import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  objectiveSubmissions,
  submissionJobItems,
} from "../../../../shared/db/schema.ts";
import { getLogger } from "@logtape/logtape";
import {
  bumpSubmissionCountRevisions,
  lockProjectionHosts,
} from "./projection.ts";
import {
  consumeDomainUpgradeQuota,
  consumeUpgradeQuota,
  type UpgradeQuotaConsumer,
  UpgradeQuotaDeferredError,
} from "./job-attempt.ts";
import { assertDomainJobExecution } from "./domain-job-access.ts";
import type { SystemActor } from "../../../access/contracts/actor.ts";
import {
  type ClaimedJobItem,
  completeJobItem,
  requeueJobItem,
  scheduleDispatchRetryOrFail,
} from "./job-worker.ts";
import { rejudgeObjectiveSubmissionForJobTx } from "../objective/versioning/objective-regrade-job.ts";
import {
  assertObjectiveSourceDispatchable,
  completeSourceContention,
} from "./dispatch-source.ts";
import type {
  DispatchOutcome,
  DispatchSource,
  LeaseGate,
} from "./dispatch-types.ts";

const logger = getLogger(["noj", "submission"]);
const EVALUATION_WORKER_ACTOR: SystemActor = {
  kind: "system",
  purpose: "background_task",
};

/**
 * 客观题重判：在源行锁内按目标版本快照重新判卷，并与条目完成放在同一事务。
 */
export async function dispatchObjectiveRejudge(input: {
  item: ClaimedJobItem;
  owner: string;
  source: DispatchSource;
  targetVersionId: string;
}): Promise<DispatchOutcome> {
  const { item, owner, source } = input;
  // 闭包内无法保留 `item` 的可空收窄，先固化为非空局部量
  const objectiveTargetVersionId = input.targetVersionId;
  try {
    // 重判与源行锁复查放在同一事务：锁内发现源已删除/正在评测 → skipped（#8）
    await getDb().transaction(async (tx) => {
      if (!item.attempt_id) {
        await assertDomainJobExecution(item, source, "rejudge", tx);
      }
      // Handbook §5.1：先锁题库与竞赛宿主，再锁客观题提交行。
      // 与策略切换重算保持相同的 host → source 顺序，避免双方互等。
      await lockProjectionHosts(tx, {
        kind: "objective",
        id: source.id,
        problem_id: source.problem_id,
        contest_id: source.contest_id,
      });
      await assertObjectiveSourceDispatchable(tx, source.id);
      const result = await rejudgeObjectiveSubmissionForJobTx(
        tx,
        EVALUATION_WORKER_ACTOR,
        {
          submissionId: source.id,
          targetVersionId: objectiveTargetVersionId,
          jobKind: "rejudge",
          jobItemId: item.id,
          leaseOwner: owner,
        },
      );
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

/**
 * 客观题升级：创建新的**练习**提交并同步重判。
 *
 * 客观题竞赛只允许一次提交，因此升级一律落练习提交（原竞赛提交仍可被管理员重测）；
 * 新提交记录 `upgraded_from_id` 并使用当前时间。
 */
export async function dispatchObjectiveUpgrade(input: {
  item: ClaimedJobItem;
  source: DispatchSource;
  targetVersionId: string;
  owner: string;
  quotaConsumer: UpgradeQuotaConsumer;
  lease: LeaseGate;
}): Promise<DispatchOutcome> {
  const { item, source, targetVersionId, owner } = input;
  const db = getDb();
  try {
    // 创建升级副本（新提交 + 额度 + 重判）不可回退，必须在事务前确认仍持有租约。
    await input.lease.assertHeld();
    await db.transaction(async (tx) => {
      const execution = await assertDomainJobExecution(
        item,
        source,
        "upgrade",
        tx,
      );
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
      await consumeDomainUpgradeQuota(
        execution.domain_id,
        source.user_id,
        item.id,
        tx,
      );
      await tx.insert(objectiveSubmissions).values({
        domain_id: execution.domain_id,
        domain_problem_binding_id: execution.domain_problem_binding_id,
        assignment_id: source.assignment_id,
        assignment_item_id: source.assignment_item_id,
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
      await rejudgeObjectiveSubmissionForJobTx(tx, EVALUATION_WORKER_ACTOR, {
        submissionId: newId,
        targetVersionId,
        jobKind: "upgrade",
        jobItemId: item.id,
        leaseOwner: input.owner,
      });
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
