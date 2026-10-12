import { sql } from "drizzle-orm";
import type { Executor } from "../../../shared/db/executor.ts";
import { assignmentItemHistory } from "../../../shared/db/schema.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";

interface BindingChange {
  item_id: string;
  domain_id: string;
  problem_id: string;
  binding_history_id: string;
  answer_version_id: string | null;
  effective_version_mode: "any" | "exact";
  required_version_id: string | null;
  revision: number;
  actor_id: string;
  reason: string;
  created_at: string;
}

/** 从不可变绑定依据补齐每一次变化，不因消费者延迟只保存最后一个策略。 */
export async function appendAssignmentBindingHistory(
  executor: Executor,
  assignmentId: string,
) {
  const rows = unwrapRows<BindingChange>(
    await executor.execute(sql`
    SELECT i.id AS item_id, i.domain_id, i.problem_id, h.id AS binding_history_id,
      h.answer_version_id, h.effective_version_mode, h.required_version_id, h.revision, h.actor_id, h.reason, h.created_at
    FROM assignment_items i JOIN problem_binding_history h ON h.binding_id = i.binding_id
    WHERE i.assignment_id = ${assignmentId} AND h.revision > i.published_policy_revision
      AND NOT EXISTS (SELECT 1 FROM assignment_item_history old WHERE old.item_id = i.id AND old.binding_history_id = h.id)
    ORDER BY i.id, h.revision LIMIT 500`) as never,
  );
  if (rows.length) {
    await executor.insert(assignmentItemHistory).values(rows.map((h) => ({
      id: crypto.randomUUID(),
      item_id: h.item_id,
      domain_id: h.domain_id,
      problem_id: h.problem_id,
      binding_history_id: h.binding_history_id,
      answer_version_id: h.answer_version_id,
      policy_mode: h.effective_version_mode,
      required_version_id: h.required_version_id,
      policy_revision: h.revision,
      actor_id: h.actor_id,
      reason: h.reason,
      created_at: h.created_at,
    }))).onConflictDoNothing();
  }
  return { changes: rows, has_more: rows.length === 500 };
}
