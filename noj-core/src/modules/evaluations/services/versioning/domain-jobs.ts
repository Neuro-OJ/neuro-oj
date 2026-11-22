import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";
import { AppError, NotFoundError } from "../../../../shared/base/errors.ts";
import {
  contests,
  domainProblemBindings,
  submissionJobItems,
  submissionJobs,
} from "../../../../shared/db/schema.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { workspaceAudit } from "../../../access/contracts/cross-module/workspace_services_domains.ts";
import { setDomainProblemBindingPolicy } from "../../../problems/contracts/cross-module/services_workspace_problem-bindings.ts";
import { assertDomainPracticeAllowed } from "../../../contests/contracts/cross-module/services_practice-admission.ts";
import { loadDomainContest } from "../../../contests/contracts/cross-module/services_domain-access.ts";
import { verifyContestAccess } from "../../../contests/contracts/cross-module/services_contest-access.ts";
import { resolveDomainJobContexts } from "./domain-job-access.ts";
import {
  getRejudgeJob,
  hashCanonical,
  idempotencyConflict,
  insertJobItemsBatched,
  listRejudgeJobItems,
  MAX_SELECTED_SUBMISSIONS,
  normalizeRejudgeRequest,
  planItems,
  refreshJobStatus,
  type RejudgeRequest,
  type RejudgeScope,
} from "./rejudge-jobs.ts";
import type { UpgradeRequest } from "./upgrade-jobs.ts";

type DomainRejudgeRequest = RejudgeRequest & {
  policy_changes?: Array<
    NonNullable<RejudgeRequest["policy_changes"]>[number] & { reason: string }
  >;
};
export type DomainJobRequest =
  | DomainRejudgeRequest
  | ({ kind: "upgrade" } & UpgradeRequest);
interface Source {
  kind: "submission" | "objective";
  id: string;
  domain_id: string | null;
  domain_problem_binding_id: string | null;
  user_id: string;
  problem_id: string;
  contest_id: string | null;
  submitted_version_id: string | null;
  active_attempt_id: string | null;
}
const sources = sql`(
 SELECT 'submission'::text AS kind,id,domain_id,domain_problem_binding_id,user_id,problem_id,contest_id,submitted_version_id,active_attempt_id FROM submissions
 UNION ALL
 SELECT 'objective'::text AS kind,id,domain_id,domain_problem_binding_id,user_id,paper_id AS problem_id,contest_id,submitted_version_id,active_attempt_id FROM objective_submissions
) candidates`;
async function loadSources(
  scope: RejudgeScope,
  domainId: string,
  executor: Executor,
) {
  const filter = scope.type === "selected"
    ? sql`AND (${
      sql.join(
        scope.submissions.map((entry) =>
          sql`(candidates.kind=${entry.kind} AND candidates.id=${entry.id})`
        ),
        sql` OR `,
      )
    })`
    : scope.type === "problem"
    ? sql`AND candidates.problem_id=${scope.problem_id}`
    : sql`AND candidates.contest_id=${scope.contest_id}`;
  if (scope.type === "selected" && !scope.submissions.length) return [];
  const rows = unwrapRows<Source>(
    await executor.execute(
      sql`SELECT * FROM ${sources} WHERE candidates.domain_id=${domainId} ${filter} ORDER BY candidates.kind,candidates.id`,
    ) as never,
  );
  if (scope.type === "selected") {
    const ids = new Set(
      scope.submissions.map((entry) => `${entry.kind}:${entry.id}`),
    );
    if (rows.length !== ids.size) {
      throw new NotFoundError("任务提交不存在或不属于当前工作空间");
    }
  }
  if (scope.type === "contest") {
    const [contest] = await executor.select({ id: contests.id }).from(contests)
      .where(
        and(
          eq(contests.id, scope.contest_id),
          eq(contests.domain_id, domainId),
        ),
      );
    if (!contest) throw new NotFoundError("比赛不存在");
  }
  if (scope.type === "problem") {
    const [binding] = await executor.select({ id: domainProblemBindings.id })
      .from(domainProblemBindings)
      .where(
        and(
          eq(domainProblemBindings.domain_id, domainId),
          eq(domainProblemBindings.problem_id, scope.problem_id),
        ),
      );
    if (!binding) throw new NotFoundError("题目不存在");
  }
  return rows;
}
async function access(
  slug: string,
  actorId: string,
  write = false,
  executor: Executor = getDb(),
) {
  return await loadWorkspace(slug, actorId, { write, executor });
}
export async function acceptDomainSubmissionJob(
  slug: string,
  actorId: string,
  request: DomainJobRequest,
  key: string,
) {
  if (!key || key.length > 128) {
    throw new AppError(
      "需要 Idempotency-Key（≤128 字符）",
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  const workspace = await access(slug, actorId, true);
  if (!request || !["upgrade", "rejudge"].includes(request.kind)) {
    throw new AppError("任务类型非法", 400, "INVALID_JOB_KIND");
  }
  assertWorkspacePermission(
    workspace.context,
    request.kind === "rejudge" ? "submission:rejudge" : "submission:create",
  );
  let scope: RejudgeScope;
  let normalized: DomainJobRequest;
  if (request.kind === "rejudge") {
    normalized = normalizeRejudgeRequest(request) as DomainRejudgeRequest;
    scope = normalized.scope;
    if (
      scope.type === "selected" &&
      scope.submissions.length > MAX_SELECTED_SUBMISSIONS
    ) {
      throw new AppError(
        "所选提交不得超过 500 条",
        400,
        "TOO_MANY_SUBMISSIONS",
      );
    }
    if (
      scope.type === "selected" &&
      scope.submissions.some((entry) =>
        !entry || !["submission", "objective"].includes(entry.kind) ||
        typeof entry.id !== "string" || !entry.id
      )
    ) {
      throw new AppError("提交选择非法", 400, "INVALID_JOB_SCOPE");
    }
    if (!Array.isArray(normalized.policy_changes)) {
      throw new AppError("策略变更必须为数组", 400, "INVALID_POLICY_CHANGE");
    }
    for (const change of normalized.policy_changes ?? []) {
      if (
        !change || typeof change.reason !== "string" || !change.reason.trim() ||
        change.reason.length > 2000
      ) {
        throw new AppError(
          "策略变化必须提供理由",
          400,
          "POLICY_REASON_REQUIRED",
        );
      }
    }
  } else {
    if (
      !Array.isArray(request.submissions) ||
      request.submissions.length > MAX_SELECTED_SUBMISSIONS ||
      request.submissions.some((entry) =>
        !entry || !["submission", "objective"].includes(entry.kind) ||
        typeof entry.id !== "string" || !entry.id
      ) ||
      request.context !== undefined &&
        !["practice", "source_contest"].includes(request.context)
    ) {
      throw new AppError(
        "升级提交集合或上下文非法",
        400,
        "INVALID_UPGRADE_REQUEST",
      );
    }
    scope = {
      type: "selected",
      submissions: [
        ...new Map(
          request.submissions.map(
            (entry) => [`${entry.kind}:${entry.id}`, entry],
          ),
        ).values(),
      ],
    };
    normalized = {
      kind: "upgrade",
      submissions: scope.submissions,
      context: request.context ?? "practice",
    };
  }
  const hash = await hashCanonical(normalized), db = getDb();
  const existing = async (executor: Executor) => {
    const [job] = await executor.select().from(submissionJobs).where(
      and(
        eq(submissionJobs.domain_id, workspace.domain.id),
        eq(submissionJobs.actor_id, actorId),
        eq(submissionJobs.kind, request.kind),
        eq(submissionJobs.idempotency_key, key),
      ),
    );
    if (!job) return null;
    if (job.request_hash !== hash) throw idempotencyConflict();
    return {
      job_id: job.id,
      status: job.status,
      total_items: (await getRejudgeJob(job.id))!.total_items,
      existing: true,
    };
  };
  const previous = await existing(db);
  if (previous) return previous;
  try {
    return await db.transaction(async (tx) => {
      const members = await loadSources(scope, workspace.domain.id, tx);
      const problemIds = [
        ...new Set(members.map((source) => source.problem_id)),
      ];
      if (scope.type === "problem" && !problemIds.includes(scope.problem_id)) {
        problemIds.push(scope.problem_id);
      }
      const changes = normalized.kind === "rejudge"
        ? normalized.policy_changes ?? []
        : [];
      const current = await resolveDomainJobContexts(
        slug,
        actorId,
        normalized.kind === "upgrade" && normalized.context === "source_contest"
          ? []
          : problemIds,
        tx,
        changes.length > 0,
        undefined,
        normalized.kind === "rejudge",
      );
      assertWorkspacePermission(
        current.access.context,
        request.kind === "rejudge" ? "submission:rejudge" : "submission:create",
      );
      const manager = current.access.platformAdmin ||
        current.access.context.domainPermissions.has("submission:rejudge");
      if (
        request.kind === "upgrade" && !manager &&
        members.some((source) => source.user_id !== actorId)
      ) throw new NotFoundError("任务提交不存在");
      const planned: Array<
        {
          source_kind: "submission" | "objective";
          source_id: string;
          problem_id: string;
          target_version_id: string | null;
          target_version_ref: string | null;
          skipped_reason?: { code: string; message: string };
        }
      > = [];
      if (normalized.kind === "rejudge") {
        planned.push(...await planItems(members, normalized.target, tx));
        for (const change of changes) {
          if (
            !members.some((source) =>
              source.problem_id === change.problem_id &&
              (!change.contest_id || source.contest_id === change.contest_id)
            )
          ) {
            throw new AppError(
              "策略变化不属于任务范围",
              400,
              "POLICY_CHANGE_OUTSIDE_SCOPE",
            );
          }
        }
      } else {for (const source of members) {
          // 组织者代表原参赛者升级时，沿用原参赛者经服务端核验的比赛入口。
          // 不能把批任务当作普通练习入口绕过保密，也不要求组织者本人报名。
          const context =
            normalized.context === "source_contest" && source.contest_id
              ? (await resolveDomainJobContexts(
                slug,
                source.user_id,
                [source.problem_id],
                tx,
                false,
                source.contest_id,
              )).contexts.get(source.problem_id)!
              : current.contexts.get(source.problem_id);
          if (!context) {
            throw new AppError(
              "源提交没有有效比赛上下文",
              403,
              "CONTEST_CONTEXT_REQUIRED",
            );
          }
          current.contexts.set(source.problem_id, context);
          const target = context.answer_version_id;
          let reason: { code: string; message: string } | undefined;
          if (source.active_attempt_id) {
            reason = { code: "SOURCE_JUDGING", message: "源提交正在评测" };
          } else if (normalized.context === "source_contest") {
            if (source.kind === "objective") {
              throw new AppError(
                "客观题比赛仅允许一次正式交卷",
                409,
                "OBJECTIVE_CONTEST_UPGRADE_FORBIDDEN",
              );
            }
            if (!source.contest_id) {
              reason = {
                code: "CONTEST_CONTEXT_REQUIRED",
                message: "源提交没有比赛上下文",
              };
            } else {
              await loadDomainContest(slug, source.contest_id, actorId, {
                executor: tx,
                write: true,
                manage: true,
              });
              const permission = await verifyContestAccess(
                source.user_id,
                source.contest_id,
                source.problem_id,
                { domainId: workspace.domain.id, executor: tx },
              );
              if (!permission.allowed || !permission.running) {
                throw new AppError(
                  "比赛已结束或不允许升级",
                  403,
                  "UPGRADE_ACCESS_DENIED",
                );
              }
              const [contestProblem] = unwrapRows<
                { pinned_version_id: string | null }
              >(
                await tx.execute(
                  sql`SELECT pinned_version_id FROM contest_problems WHERE contest_id=${source.contest_id} AND problem_id=${source.problem_id} AND domain_id=${workspace.domain.id}`,
                ) as never,
              );
              if (contestProblem?.pinned_version_id !== target) {
                reason = {
                  code: "CONTEST_VERSION_MISMATCH",
                  message: "比赛固定版本与当前作答版本不同",
                };
              }
            }
          } else {await assertDomainPracticeAllowed(
              workspace.domain.id,
              source.problem_id,
              source.user_id,
              tx,
            );}
          if (!reason && source.submitted_version_id === target) {
            reason = {
              code: "ALREADY_LATEST",
              message: "源提交已使用当前作答版本",
            };
          }
          planned.push({
            source_kind: source.kind,
            source_id: source.id,
            problem_id: source.problem_id,
            target_version_id: target,
            target_version_ref: target,
            skipped_reason: reason,
          });
        }}
      for (const change of changes) {
        const ref = current.contexts.get(change.problem_id)!.reference;
        if (change.contest_id) {
          const { setContestProblemEffectiveVersionPolicy } = await import(
            "./effective-policy.ts"
          );
          await setContestProblemEffectiveVersionPolicy(
            change.contest_id,
            change.problem_id,
            {
              policy: change.policy,
              expectedRevision: change.expected_revision,
              actorId,
            },
            tx,
          );
        } else {await setDomainProblemBindingPolicy(
            slug,
            ref,
            actorId,
            change.expected_revision,
            change.policy,
            change.reason,
            tx,
          );}
      }
      const id = crypto.randomUUID(),
        now = new Date().toISOString(),
        complete = planned.every((item) => !!item.skipped_reason);
      await tx.insert(submissionJobs).values({
        id,
        domain_id: workspace.domain.id,
        kind: request.kind,
        actor_id: actorId,
        idempotency_key: key,
        request_hash: hash,
        request: { ...normalized, domain_slug: slug },
        status: complete ? "completed" : "queued",
        created_at: now,
        finished_at: complete ? now : null,
      });
      await insertJobItemsBatched(
        tx,
        planned.map((item, ordinal) => ({
          id: crypto.randomUUID(),
          job_id: id,
          domain_id: workspace.domain.id,
          domain_problem_binding_id:
            current.contexts.get(item.problem_id)!.domain_problem_binding_id,
          ordinal,
          source_kind: item.source_kind,
          source_id: item.source_id,
          problem_id: item.problem_id,
          target_version_id: item.target_version_id,
          target_version_ref: item.target_version_ref,
          status: item.skipped_reason ? "skipped" : "pending",
          reason_code: item.skipped_reason?.code ?? null,
          reason_message: item.skipped_reason?.message ?? null,
          created_at: now,
          finished_at: item.skipped_reason ? now : null,
        })),
      );
      await workspaceAudit(tx, actorId, workspace.domain.id, "domain.update", {
        operation: "submission.job.create",
        job_id: id,
        kind: request.kind,
      });
      return {
        job_id: id,
        status: complete ? "completed" : "queued",
        total_items: planned.length,
        skipped_items: planned.filter((item) => item.skipped_reason).length,
        existing: false,
      };
    });
  } catch (error) {
    const raced = await existing(db);
    if (raced) return raced;
    throw error;
  }
}
async function readableJob(
  slug: string,
  actorId: string,
  id: string,
  write = false,
  executor: Executor = getDb(),
) {
  const workspace = await access(slug, actorId, write, executor);
  const [job] = await executor.select().from(submissionJobs).where(
    and(
      eq(submissionJobs.id, id),
      eq(submissionJobs.domain_id, workspace.domain.id),
    ),
  );
  if (
    !job ||
    job.actor_id !== actorId && !workspace.platformAdmin &&
      !workspace.context.domainPermissions.has("submission:rejudge")
  ) throw new NotFoundError("任务不存在");
  return { workspace, job };
}
export async function getDomainSubmissionJob(
  slug: string,
  actorId: string,
  id: string,
) {
  const { workspace, job } = await readableJob(slug, actorId, id);
  return {
    ...await getRejudgeJob(id),
    domain_id: workspace.domain.id,
    cancel_requested: !!(job.request as { cancel_requested_at?: string })
      .cancel_requested_at,
  };
}
export async function listDomainSubmissionJobItems(
  slug: string,
  actorId: string,
  id: string,
  options: Parameters<typeof listRejudgeJobItems>[1],
) {
  await readableJob(slug, actorId, id);
  const result = await listRejudgeJobItems(id, options);
  const locators = result.data.length
    ? await getDb().select({
      id: submissionJobItems.id,
      result_submission_id: submissionJobItems.result_submission_id,
      domain_id: submissionJobItems.domain_id,
      domain_problem_binding_id: submissionJobItems.domain_problem_binding_id,
    }).from(submissionJobItems).where(
      and(
        eq(submissionJobItems.job_id, id),
        inArray(
          submissionJobItems.id,
          result.data.map((item) => item.id),
        ),
      ),
    )
    : [];
  const byId = new Map(locators.map((row) => [row.id, row]));
  return {
    ...result,
    data: result.data.map((row) => ({ ...row, ...byId.get(row.id)! })),
  };
}
/** 取消尚未创建尝试的条目，已经受理的评测继续完成，不改写其正式判定。 */
export async function cancelDomainSubmissionJob(
  slug: string,
  actorId: string,
  id: string,
) {
  return await getDb().transaction(async (tx) => {
    const { workspace, job } = await readableJob(slug, actorId, id, true, tx);
    await tx.select({ id: submissionJobs.id }).from(submissionJobs).where(
      eq(submissionJobs.id, id),
    ).for("update");
    const now = new Date().toISOString();
    await tx.update(submissionJobs).set({
      request: {
        ...job.request as object,
        cancel_requested_at: now,
        cancelled_by: actorId,
      },
    }).where(eq(submissionJobs.id, id));
    await tx.update(submissionJobItems).set({
      status: "skipped",
      reason_code: "JOB_CANCELLED",
      reason_message: "任务已取消",
      finished_at: now,
      lease_owner: null,
      lease_until: null,
    })
      .where(
        and(
          eq(submissionJobItems.job_id, id),
          isNull(submissionJobItems.attempt_id),
          or(
            eq(submissionJobItems.status, "pending"),
            eq(submissionJobItems.status, "preparing"),
          ),
        ),
      );
    const status = await refreshJobStatus(id, tx);
    await workspaceAudit(tx, actorId, workspace.domain.id, "domain.update", {
      operation: "submission.job.cancel",
      job_id: id,
    });
    return {
      id,
      domain_id: workspace.domain.id,
      status,
      cancel_requested: true,
    };
  });
}
