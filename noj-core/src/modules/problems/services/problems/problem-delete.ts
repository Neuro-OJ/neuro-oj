/**
 * 题目删除事务步骤：prepare / owned rows / finalize（拉自 problems-crud.ts，纯搬移）。
 *
 * 评测行的在途检查与删除经 evaluations 的合同统一由 application 的
 * deleteProblemCommand 编排（P3 §3.3）。
 */
import { eq, inArray } from "drizzle-orm";
import type { DbTx } from "../../../../shared/db/executor.ts";
import { adjustDomainResourceCounterTx } from "../../../access/resource-counters.ts";
import { assertProblemEvaluationDeletionAllowedTx } from "../../../evaluations/contracts/problem-deletion.ts";
import {
  contestProblems,
  domainProblemBindings,
  domains,
  problemBindingHistory,
  problemDraftObjects,
  problemDrafts,
  problems,
  problemVersionObjects,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import {
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { deleteStorageObject } from "../../../assets/contracts/cross-module/services_registry.ts";
import { getStorageProvider } from "../../../assets/storage/mod.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "catalog"]);
import {
  type AuditDetail,
  logAudit,
  recordAudit,
} from "../../../platform/contracts/cross-module/system_services_audit-log.ts";
import { enqueueSearchIndexTask } from "../../../application/search-tasks.ts";
import type { UserActor } from "../../../access/contracts/actor.ts";
import { assertProblemHasNoRetainedReferences } from "../workspace/problem-retention.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../../shared/workspace/types.ts";

/**
 * 删除题目。
 *
 * 权限规则：
 * - admin 可删除任意题目
 * - 物理删除只允许源域治理角色，保留历史资源由引用守卫保护
 *
 * @throws {NotFoundError} 题目不存在
 * @throws {ForbiddenError} 权限不足
 */
export interface DeleteProblemTxResult {
  readonly problem: typeof problems.$inferSelect;
  readonly objectUrls: readonly string[];
}

/**
 * 删除第一阶段：锁内完成全部授权与保留性检查。
 *
 * 只读不写；返回后续阶段需要的题目事实与待回收对象。必须与
 * `deleteProblemOwnedRowsTx` 在同一事务中执行，否则锁会提前释放。
 */
export async function prepareProblemDeletionTx(
  id: string,
  userId: string,
  tx: DbTx,
): Promise<DeleteProblemTxResult> {
  const existing = await tx.select().from(problems).where(eq(problems.id, id))
    .limit(1);
  if (existing.length === 0) throw new NotFoundError("题目不存在");

  const problem = existing[0];
  const [sourceDomain] = problem.domain_id
    ? await tx.select({ slug: domains.slug }).from(domains).where(
      eq(domains.id, problem.domain_id),
    )
    : [{ slug: DEFAULT_DOMAIN_SLUG }];
  if (!sourceDomain) throw new NotFoundError("源题工作空间不存在");
  const workspace = await loadWorkspace(sourceDomain.slug, userId, {
    write: true,
  });
  assertWorkspacePermission(workspace.context, "problem:delete_any");

  const [contestRef] = await tx.select({
    problem_id: contestProblems.problem_id,
  })
    .from(contestProblems)
    .where(eq(contestProblems.problem_id, id)).limit(1);
  if (contestRef) throw new ConflictError("题目已被竞赛引用，无法删除");

  // 收集待清理的存储对象；实际删除必须在事务提交后经过引用守卫。
  const objectUrls = new Set<string>();
  if (problem.support_package_storage_url) {
    objectUrls.add(problem.support_package_storage_url);
  }
  const draftObjectRows = await tx.select({
    storage_url: problemDraftObjects.storage_url,
  }).from(problemDraftObjects).where(eq(problemDraftObjects.problem_id, id));
  for (const row of draftObjectRows) objectUrls.add(row.storage_url);
  const versionObjectRows = await tx.select({
    storage_url: problemVersionObjects.storage_url,
  }).from(problemVersionObjects).innerJoin(
    problemVersions,
    eq(problemVersions.id, problemVersionObjects.version_id),
  ).where(eq(problemVersions.problem_id, id));
  for (const row of versionObjectRows) objectUrls.add(row.storage_url);

  // 排他题目锁与尝试创建互斥；检查与全部关联清理必须原子提交。
  if (problem.domain_id) {
    await tx.select({ id: domains.id }).from(domains).where(
      eq(domains.id, problem.domain_id),
    ).for("update");
  }
  await tx.select({ id: problems.id }).from(problems).where(eq(problems.id, id))
    .for("update");
  const [lockedContestRef] = await tx.select().from(contestProblems).where(
    eq(contestProblems.problem_id, id),
  ).limit(1);
  if (lockedContestRef) throw new ConflictError("题目已被竞赛引用，无法删除");
  // 在途评测检查与保留引用检查都必须在**删除任何行之前**完成：
  // 先删评测行会让保留性守卫看不到历史提交，从而误删有历史的源题。
  await assertProblemEvaluationDeletionAllowedTx(tx, id);
  await assertProblemHasNoRetainedReferences(id, tx);
  return { problem, objectUrls: [...objectUrls] };
}

/**
 * 删除第三阶段：删除 problems 拥有的行。
 *
 * 调用方必须已经依次完成 `prepareProblemDeletionTx` 与 evaluations 的
 * `deleteProblemEvaluationRowsTx`。`self_tests` 通过绑定外键引用
 * `domain_problem_bindings`，所以评测行必须先清空，否则绑定删除会 23503。
 */
export async function deleteProblemOwnedRowsTx(
  id: string,
  domainId: string | null,
  tx: DbTx,
): Promise<void> {
  await tx.delete(problemBindingHistory).where(
    eq(problemBindingHistory.problem_id, id),
  );
  const bindings = await tx.delete(domainProblemBindings).where(
    eq(domainProblemBindings.problem_id, id),
  ).returning();
  if (domainId && bindings.length) {
    await adjustDomainResourceCounterTx(
      tx,
      domainId,
      "problems",
      -bindings.length,
    );
  }
  await tx.delete(problemDraftObjects).where(
    eq(problemDraftObjects.problem_id, id),
  );
  await tx.delete(problemVersionObjects).where(
    inArray(
      problemVersionObjects.version_id,
      tx.select({ id: problemVersions.id }).from(problemVersions).where(
        eq(problemVersions.problem_id, id),
      ),
    ),
  );
  await tx.update(problems).set({
    latest_version_id: null,
    required_version_id: null,
    effective_version_mode: "any",
  }).where(eq(problems.id, id));
  await tx.delete(problemDrafts).where(eq(problemDrafts.problem_id, id));
  await tx.delete(problemVersions).where(eq(problemVersions.problem_id, id));
  await tx.delete(problems).where(eq(problems.id, id));
}

export async function finalizeDeletedProblem(
  id: string,
  result: DeleteProblemTxResult,
  actor: UserActor | null = null,
): Promise<void> {
  // 存储对象统一经引用守卫删除：仍被其他题目/版本引用时保留字节
  for (const url of result.objectUrls) {
    try {
      await deleteStorageObject(url);
    } catch (err) {
      await getStorageProvider().catch(() => null);
      logger.error("清理题目存储对象失败", { storage_url: url, err });
    }
  }

  // 审计日志：删除成功后才记录（display_id 为域内数字题号）
  // 审计必须带上**真实操作者**：审计列表默认过滤掉系统身份（admin_id='0'）的记录，
  // 用 logAudit（系统主体）会让删除动作在管理端完全不可见。
  if (actor) {
    await recordAudit(
      actor,
      { ipAddress: "system" },
      "problems.delete",
      {
        action: "problems.delete",
        title: result.problem.title,
        display_id: String(result.problem.number),
      } as AuditDetail,
      { type: "problem", id },
    );
  } else {
    await logAudit(
      "problems.delete",
      {
        action: "problems.delete",
        title: result.problem.title,
        display_id: String(result.problem.number),
      },
      { type: "problem", id },
    );
  }

  await enqueueSearchIndexTask("problem", id, "delete");
}
