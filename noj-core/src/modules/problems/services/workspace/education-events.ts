import { and, eq } from "drizzle-orm";
import type { DbTx } from "../../../../shared/db/executor.ts";
import {
  domainProblemBindings,
  problemBindingHistory,
  problems,
} from "../../../../shared/db/schema.ts";
import { ROOT_USER_ID } from "../../../../shared/base/constants.ts";
import {
  recordModuleChangeTx,
  recordProblemChangeTx,
} from "../../../education/contracts/events.ts";

/** 发布持有源题宿主锁；any 的作答默认版本变化同事务保存每个使用域的依据。 */
export async function recordPublishedBindingChanges(
  tx: DbTx,
  problemId: string,
  versionId: string,
  actorId: string | null,
  now: string,
) {
  const bindings = await tx.select().from(domainProblemBindings).where(
    and(
      eq(domainProblemBindings.problem_id, problemId),
      eq(domainProblemBindings.effective_version_mode, "any"),
    ),
  ).orderBy(domainProblemBindings.domain_id, domainProblemBindings.id).for(
    "update",
  );
  for (const binding of bindings) {
    const revision = binding.revision + 1;
    await tx.update(domainProblemBindings).set({
      revision,
      updated_at: now,
    }).where(eq(domainProblemBindings.id, binding.id));
    await tx.insert(problemBindingHistory).values({
      id: crypto.randomUUID(),
      binding_id: binding.id,
      problem_id: problemId,
      revision,
      effective_version_mode: "any",
      required_version_id: null,
      answer_version_id: versionId,
      disabled_at: binding.disabled_at,
      actor_id: actorId ?? ROOT_USER_ID,
      reason: "源题发布新版本",
      created_at: now,
    });
    await recordProblemChangeTx(tx, {
      domainId: binding.domain_id,
      problemId,
    });
  }
}

/** 域进入政策或状态变化影响其全部引用，按域顺序登记避免相反钟锁顺序。 */
export async function recordSourceDomainEducationChange(
  tx: DbTx,
  sourceDomainId: string,
) {
  const rows = await tx.select({ id: domainProblemBindings.domain_id })
    .from(domainProblemBindings)
    .innerJoin(problems, eq(problems.id, domainProblemBindings.problem_id))
    .where(eq(problems.domain_id, sourceDomainId));
  for (
    const domainId of [...new Set([sourceDomainId, ...rows.map((r) => r.id)])]
      .sort()
  ) {
    if (domainId === sourceDomainId) {
      await recordModuleChangeTx(tx, { domainId });
    } else {
      await recordProblemChangeTx(tx, { domainId });
    }
  }
}

/** 可见性、共享和下架变化只登记使用域事件，不在资源事务更新教学矩阵。 */
export async function recordProblemEducationChange(
  tx: DbTx,
  problemId: string,
) {
  const bindings = await tx.select({
    domain_id: domainProblemBindings.domain_id,
  }).from(domainProblemBindings)
    .where(eq(domainProblemBindings.problem_id, problemId)).orderBy(
      domainProblemBindings.domain_id,
    );
  for (const binding of bindings) {
    await recordProblemChangeTx(tx, {
      domainId: binding.domain_id,
      problemId,
    });
  }
}
