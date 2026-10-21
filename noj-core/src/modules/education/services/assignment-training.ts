import { eq } from "drizzle-orm";
import type { Executor } from "../../../shared/db/executor.ts";
import { assignmentItems, assignments } from "../../../shared/db/schema.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { importDomainProblem } from "../../problems/contracts/cross-module/services_workspace_problem-bindings.ts";
import { readDomainTraining } from "../../problems/contracts/cross-module/services_workspace_training-access.ts";

/** 发布事务内展开当前题单，建立使用域绑定并固定顺序；任意题失效则整体回滚。 */
export async function expandAssignmentTraining(
  tx: Executor,
  slug: string,
  actorId: string,
  assignment: typeof assignments.$inferSelect,
) {
  if (!assignment.source_training_id) return;
  const training = await readDomainTraining(
    slug,
    assignment.source_training_id,
    actorId,
    tx,
  );
  if (!training.items.length || training.items.length > 200) {
    throw new BadRequestError("作业题单需要 1–200 道题");
  }
  const rule = assignment.source_training_rule!;
  const rows: Array<typeof assignmentItems.$inferInsert> = [];
  for (const [sort_order, item] of training.items.entries()) {
    const bindingId = item.binding_id ??
      (item.is_shared
        ? (await importDomainProblem(slug, item.qualified_ref, actorId, tx))
          .binding.id
        : null);
    if (!bindingId) throw new BadRequestError("题目不在此域题库中");
    rows.push({
      id: crypto.randomUUID(),
      domain_id: assignment.domain_id,
      assignment_id: assignment.id,
      binding_id: bindingId,
      problem_id: item.problem_id,
      sort_order,
      ...rule,
    });
  }
  await tx.delete(assignmentItems).where(
    eq(assignmentItems.assignment_id, assignment.id),
  );
  await tx.insert(assignmentItems).values(rows);
}
