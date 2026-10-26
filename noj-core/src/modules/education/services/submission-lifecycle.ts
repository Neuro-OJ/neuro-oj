import { and, eq, or, sql } from "drizzle-orm";
import type { DbTx } from "../../../shared/db/executor.ts";
import {
  assignmentProgress,
  assignments,
  submissionAnnotations,
} from "../../../shared/db/schema.ts";
import { ConflictError } from "../../../shared/base/errors.ts";
import { recordEducationEvent } from "../contracts/facts.ts";

/** 删除先释放派生尝试指针并登记重算；其他候选及教学历史不随提交级联清除。 */
export async function prepareEducationSubmissionDeletion(
  executor: DbTx,
  source: {
    id: string;
    kind: "submission" | "objective";
    domain_id: string | null;
    user_id: string;
    problem_id: string;
  },
) {
  if (!source.domain_id) return;
  if (source.kind === "submission") {
    const [annotation] = await executor.select({ id: submissionAnnotations.id })
      .from(submissionAnnotations).where(
        eq(submissionAnnotations.submission_id, source.id),
      ).limit(1);
    if (annotation) {
      throw new ConflictError(
        "此提交有教学批注，需要保留原代码依据",
        "SUBMISSION_HAS_ANNOTATIONS",
      );
    }
  }
  const sourceColumn = source.kind === "submission"
    ? sql`e.submission_id`
    : sql`e.objective_submission_id`;
  const ownsAttempt = (
    pointer:
      | typeof assignmentProgress.source_attempt_id
      | typeof assignmentProgress.accepted_attempt_id,
  ) =>
    sql`${pointer} IN (SELECT e.id FROM evaluation_attempts e WHERE ${sourceColumn} = ${source.id})`;
  const selected = and(
    eq(assignmentProgress.domain_id, source.domain_id),
    eq(assignmentProgress.user_id, source.user_id),
    or(
      ownsAttempt(assignmentProgress.source_attempt_id),
      ownsAttempt(assignmentProgress.accepted_attempt_id),
    ),
  );
  await executor.select({ id: assignments.id }).from(assignments).where(
    sql`${assignments.id} IN (
    SELECT p.assignment_id FROM assignment_progress p WHERE p.domain_id = ${source.domain_id} AND p.user_id = ${source.user_id})`,
  )
    .orderBy(assignments.id).for("update");
  await executor.update(assignmentProgress).set({
    source_submission_id: sql`CASE WHEN ${
      ownsAttempt(assignmentProgress.source_attempt_id)
    } THEN NULL ELSE ${assignmentProgress.source_submission_id} END`,
    source_kind: sql`CASE WHEN ${
      ownsAttempt(assignmentProgress.source_attempt_id)
    } THEN NULL ELSE ${assignmentProgress.source_kind} END`,
    source_attempt_id: sql`CASE WHEN ${
      ownsAttempt(assignmentProgress.source_attempt_id)
    } THEN NULL ELSE ${assignmentProgress.source_attempt_id} END`,
    accepted_attempt_id: sql`CASE WHEN ${
      ownsAttempt(assignmentProgress.accepted_attempt_id)
    } THEN NULL ELSE ${assignmentProgress.accepted_attempt_id} END`,
  }).where(selected);
  await recordEducationEvent(executor, {
    domain_id: source.domain_id,
    user_id: source.user_id,
    problem_id: source.problem_id,
    event_type: "submission.changed",
    payload: {
      operation: "delete",
      source_id: source.id,
      source_kind: source.kind,
    },
  });
}
