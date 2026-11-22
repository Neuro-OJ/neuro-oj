/** 批任务条目派发的源读取与源竞争收尾辅助。 */

import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  objectiveSubmissions,
  submissions,
} from "../../../../shared/db/schema.ts";
import { getAttempt, isTerminalAttemptState } from "./attempts.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import { type ClaimedJobItem, completeJobItem } from "./job-worker.ts";
import type { DispatchSource } from "./dispatch-types.ts";

/** 读取源提交；已删除返回 null。 */
export async function loadSource(
  item: ClaimedJobItem,
): Promise<DispatchSource | null> {
  const db = getDb();
  if (item.source_kind === "submission") {
    const [row] = await db.select({
      id: submissions.id,
      domain_id: submissions.domain_id,
      domain_problem_binding_id: submissions.domain_problem_binding_id,
      assignment_id: submissions.assignment_id,
      assignment_item_id: submissions.assignment_item_id,
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
    domain_id: objectiveSubmissions.domain_id,
    domain_problem_binding_id: objectiveSubmissions.domain_problem_binding_id,
    assignment_id: objectiveSubmissions.assignment_id,
    assignment_item_id: objectiveSubmissions.assignment_item_id,
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
    domain_id: row.domain_id,
    domain_problem_binding_id: row.domain_problem_binding_id,
    assignment_id: row.assignment_id,
    assignment_item_id: row.assignment_item_id,
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

/**
 * 锁内复查**客观题源**（复审问题 8）。
 *
 * 与普通提交一致：命中源已删除 / 仍在评测时抛统一稳定原因码，由派发层映射为
 * `skipped`（而不是被外层 `<500` 分支记成 failed、或退化成 retry）。必须在
 * `objective_submissions` 源行锁内调用，消灭"预检时源还在、锁内已被删除"的窗口。
 */
export async function assertObjectiveSourceDispatchable(
  executor: Executor,
  sourceId: string,
): Promise<void> {
  const [row] = await executor.select({
    active: objectiveSubmissions.active_attempt_id,
  }).from(objectiveSubmissions).where(
    eq(objectiveSubmissions.id, sourceId),
  ).for("update");
  if (!row) throw new AppError("源提交已删除", 409, "SOURCE_DELETED");
  if (row.active) {
    const active = await getAttempt(row.active, executor);
    if (active && !isTerminalAttemptState(active.state)) {
      throw new AppError("源提交正在评测", 409, "SOURCE_JUDGING");
    }
  }
}

/** 源竞争（已删除/正在评测）的统一 skipped 收尾。 */
export async function completeSourceContention(
  item: ClaimedJobItem,
  owner: string,
  err: unknown,
): Promise<"skipped" | null> {
  if (
    err instanceof AppError &&
    (err.code === "SOURCE_JUDGING" || err.code === "SOURCE_DELETED")
  ) {
    await completeJobItem(item.id, {
      leaseOwner: owner,
      status: "skipped",
      reasonCode: err.code,
      reasonMessage: err.message,
    });
    return "skipped";
  }
  return null;
}
