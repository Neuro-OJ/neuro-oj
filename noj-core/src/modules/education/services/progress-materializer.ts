import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  assignmentItems,
  assignmentProgress,
  assignmentRecipients,
  assignments,
} from "../../../shared/db/schema.ts";
import { loadBindingAvailability } from "../../problems/contracts/cross-module/services_workspace_binding-availability.ts";
import { loadAssignmentCandidates } from "./progress-candidates.ts";
import {
  type EducationCandidate,
  selectAssignmentProgress,
} from "./progress-selection.ts";
import { loadEducationCellRevisions } from "./progress-revisions.ts";
import { recordEducationNotice } from "../contracts/facts.ts";

/** 一次重算一页学生，按最新正式判定覆盖，不累加事件中的分数。 */
export async function recomputeAssignmentProgress(
  assignmentId: string,
  userIds: string[],
) {
  if (!userIds.length) return;
  return await getDb().transaction(async (tx) => {
    const [assignment] = await tx.select().from(assignments).where(
      eq(assignments.id, assignmentId),
    ).for("update");
    if (!assignment?.published_at) return;
    const recipients = await tx.select().from(assignmentRecipients).where(and(
      eq(assignmentRecipients.assignment_id, assignmentId),
      inArray(assignmentRecipients.user_id, userIds),
    ));
    const items = await tx.select().from(assignmentItems).where(
      eq(assignmentItems.assignment_id, assignmentId),
    ).orderBy(assignmentItems.sort_order);
    const ids = recipients.map((r) => r.user_id),
      now = new Date().toISOString();
    const deadline = [assignment.deadline_at, assignment.ended_at].filter((
      date,
    ): date is string => date !== null).sort()[0] ?? null;
    const revisionFor = await loadEducationCellRevisions(
      tx,
      assignment.domain_id,
      assignment.classroom_id,
      assignmentId,
      ids,
      items.map((i) => i.problem_id),
    );
    const resources = new Map(
      (await loadBindingAvailability(
        tx,
        assignment.domain_id,
        items.map((i) => i.binding_id),
      )).map((b) => [b.id, b]),
    );
    const byCell = new Map<string, EducationCandidate[]>();
    for (
      const candidate of await loadAssignmentCandidates(tx, assignmentId, ids)
    ) {
      const key =
        `${candidate.user_id}:${candidate.problem_id}:${candidate.scope}`;
      const cell = byCell.get(key) ?? [];
      cell.push(candidate);
      byCell.set(key, cell);
    }
    const rows: Array<typeof assignmentProgress.$inferInsert> = [];
    for (const item of items) {
      const resource = resources.get(item.binding_id);
      const available = resource?.available ?? false;
      if (
        resource &&
        (item.answer_version_id !== resource.answer_version_id ||
          item.policy_revision !== resource.revision ||
          item.resource_available !== available)
      ) {
        await tx.update(assignmentItems).set({
          answer_version_id: resource.answer_version_id,
          policy_revision: resource.revision,
          resource_available: available,
        }).where(eq(assignmentItems.id, item.id));
        if (item.resource_available && !available) {
          await recordEducationNotice(tx, {
            domain_id: assignment.domain_id,
            assignment_id: assignmentId,
            type: "resource_unavailable",
          });
        }
        // 版本、策略或可用性变化后通知一次；更新后条目与资源一致，重算/重试不会再进入本分支
        if (available) {
          await recordEducationNotice(tx, {
            domain_id: assignment.domain_id,
            assignment_id: assignmentId,
            type: "assignment_changed",
          });
        }
      }
      for (const userId of ids) {
        for (const scope of ["on_time", "current"] as const) {
          const cell = selectAssignmentProgress(
            byCell.get(`${userId}:${item.problem_id}:${scope}`) ?? [],
            item.requirement,
            item.minimum_score,
            available,
            deadline,
          );
          rows.push({
            id: crypto.randomUUID(),
            domain_id: assignment.domain_id,
            assignment_id: assignmentId,
            item_id: item.id,
            user_id: userId,
            scope,
            ...cell,
            policy_revision: resource?.revision ?? item.policy_revision,
            projection_revision: revisionFor(userId, item.problem_id),
            updated_at: now,
          });
        }
      }
    }
    for (let start = 0; start < rows.length; start += 500) {
      await tx.insert(assignmentProgress).values(rows.slice(start, start + 500))
        .onConflictDoUpdate({
          target: [
            assignmentProgress.item_id,
            assignmentProgress.user_id,
            assignmentProgress.scope,
          ],
          set: {
            status: sql`excluded.status`,
            score: sql`excluded.score`,
            accepted: sql`excluded.accepted`,
            source_submission_id: sql`excluded.source_submission_id`,
            source_kind: sql`excluded.source_kind`,
            source_attempt_id: sql`excluded.source_attempt_id`,
            evaluated_version_id: sql`excluded.evaluated_version_id`,
            accepted_attempt_id: sql`excluded.accepted_attempt_id`,
            policy_revision: sql`excluded.policy_revision`,
            projection_revision: sql`excluded.projection_revision`,
            late: sql`excluded.late`,
            updated_at: sql`excluded.updated_at`,
          },
          setWhere:
            sql`${assignmentProgress.projection_revision} <= excluded.projection_revision`,
        });
    }
  });
}
