import { and, asc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../../../../shared/db/executor.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domainProblemBindings,
  domains,
  problems,
  submissionJobs,
} from "../../../../shared/db/schema.ts";
import { AppError, NotFoundError } from "../../../../shared/base/errors.ts";
import {
  assertWorkspacePermission,
  DEFAULT_DOMAIN_ID,
  loadWorkspace,
} from "../../../workspace/index.ts";
import {
  evaluateProblemAccess,
  loadBindingAvailability,
  resolveDomainProblem,
} from "../../../catalog/index.ts";
import {
  assertDomainPracticeAllowed,
  loadDomainContest,
  verifyContestAccess,
} from "../../../contest/index.ts";
import type { DispatchSource } from "./dispatch-job-item.ts";
import type { ClaimedJobItem } from "./job-worker.ts";

export interface DomainJobContext {
  domain_id: string;
  domain_problem_binding_id: string;
  answer_version_id: string;
  reference: string;
}
export async function resolveDomainJobContexts(
  slug: string,
  actorId: string,
  problemIds: string[],
  executor: Executor,
  policyWrite = false,
) {
  const access = await loadWorkspace(slug, actorId, { executor, write: true });
  const sources = problemIds.length
    ? await executor.select({
      id: problems.id,
      domain_id: problems.domain_id,
      number: problems.number,
      slug: domains.slug,
    })
      .from(problems).leftJoin(domains, eq(domains.id, problems.domain_id))
      .where(inArray(problems.id, [...new Set(problemIds)]))
    : [];
  const domainIds = [
    ...new Set([
      access.domain.id,
      ...sources.map((source) => source.domain_id ?? DEFAULT_DOMAIN_ID),
    ]),
  ].sort();
  if (policyWrite) {
    for (
      const part of [
        domainIds.filter((id) => id < access.domain.id),
        domainIds.filter((id) => id === access.domain.id),
        domainIds.filter((id) => id > access.domain.id),
      ]
    ) {
      if (!part.length) continue;
      await executor.select({ id: domains.id }).from(domains).where(
        inArray(domains.id, part),
      ).orderBy(asc(domains.id)).for(
        part.includes(access.domain.id) ? "update" : "share",
      );
    }
  } else {
    await executor.select({ id: domains.id }).from(domains).where(
      inArray(domains.id, domainIds),
    ).orderBy(asc(domains.id)).for("share");
  }
  if (sources.length) {
    await executor.select({ id: problems.id }).from(problems).where(
      inArray(problems.id, sources.map((source) => source.id)),
    ).orderBy(asc(problems.id)).for("share");
  }
  const bindings = problemIds.length
    ? await executor.select({ id: domainProblemBindings.id }).from(
      domainProblemBindings,
    )
      .where(
        and(
          eq(domainProblemBindings.domain_id, access.domain.id),
          inArray(domainProblemBindings.problem_id, problemIds),
        ),
      ).orderBy(asc(domainProblemBindings.id)).for("share")
    : [];
  const contexts = new Map<string, DomainJobContext>();
  for (const source of sources) {
    const ref = `${source.slug ?? "main"}:${source.number}`;
    const resolved = await resolveDomainProblem(slug, ref, actorId, {
      executor,
      write: true,
    });
    contexts.set(source.id, {
      domain_id: access.domain.id,
      domain_problem_binding_id: resolved.binding.id,
      answer_version_id: resolved.version.id,
      reference: resolved.reference.qualified_ref,
    });
  }
  if (bindings.length !== contexts.size) {
    throw new NotFoundError("任务题目不存在或不可使用");
  }
  return { access, contexts };
}
/** 新尝试执行前复查当前授权；既有尝试仍允许完成，不依赖旧事件载荷。 */
export async function assertDomainJobExecution(
  item: ClaimedJobItem,
  source: DispatchSource,
  kind: "upgrade" | "rejudge",
  executor: Executor = getDb(),
) {
  const [job] = await executor.select().from(submissionJobs).where(
    eq(submissionJobs.id, item.job_id),
  );
  if (!job) throw new NotFoundError("任务不存在");
  const domainId = source.domain_id ?? DEFAULT_DOMAIN_ID;
  if (
    domainId !== (item.domain_id ?? DEFAULT_DOMAIN_ID) ||
    domainId !== (job.domain_id ?? DEFAULT_DOMAIN_ID)
  ) {
    throw new AppError(
      "任务与源提交不属于同一工作空间",
      409,
      "JOB_DOMAIN_MISMATCH",
    );
  }
  if (source.domain_problem_binding_id) {
    const [binding] = await loadBindingAvailability(executor, domainId, [
      source.domain_problem_binding_id,
    ]);
    if (!binding?.available) {
      throw new AppError("源题已不可使用", 404, "RESOURCE_UNAVAILABLE");
    }
  }
  const request = job.request as {
    domain_slug?: string;
    context?: string;
    cancel_requested_at?: string;
  };
  if (request.cancel_requested_at) {
    throw new AppError("任务已取消", 409, "JOB_CANCELLED");
  }
  const [domain] = await executor.select({ slug: domains.slug }).from(domains)
    .where(eq(domains.id, domainId));
  if (!domain) throw new NotFoundError("任务工作空间不存在");
  const access = await loadWorkspace(domain.slug, job.actor_id, {
    executor,
    write: true,
    lock: "share",
  });
  if (access.domain.id !== domainId) {
    throw new AppError("任务工作空间已失效", 409, "JOB_DOMAIN_MISMATCH");
  }
  if (kind === "rejudge") {
    assertWorkspacePermission(access.context, "submission:rejudge");
  } else {
    assertWorkspacePermission(access.context, "submission:create");
    if (job.actor_id !== source.user_id) {
      assertWorkspacePermission(access.context, "submission:rejudge");
    }
    const user = await loadWorkspace(domain.slug, source.user_id, {
      executor,
      write: true,
    });
    assertWorkspacePermission(user.context, "submission:create");
    if (request.context === "source_contest" && source.contest_id) {
      await loadDomainContest(domain.slug, source.contest_id, job.actor_id, {
        executor,
        write: true,
        manage: true,
      });
    }
  }
  let answerVersion: string | null;
  if (source.domain_problem_binding_id) {
    const resolved = await resolveDomainJobContexts(domain.slug, job.actor_id, [
      source.problem_id,
    ], executor);
    answerVersion = resolved.contexts.get(source.problem_id)!.answer_version_id;
  } else {
    // 仅扩展迁移期间的旧 main 未绑定行；仍执行当前进入、角色与源题权限。
    const [problem] = await executor.select().from(problems).where(
      eq(problems.id, source.problem_id),
    ).for("share");
    if (
      !problem || domainId !== DEFAULT_DOMAIN_ID ||
      (problem.domain_id ?? DEFAULT_DOMAIN_ID) !== domainId
    ) {
      throw new NotFoundError("源题不存在");
    }
    const contestAccess =
      request.context === "source_contest" && source.contest_id
        ? await verifyContestAccess(
          source.user_id,
          source.contest_id,
          source.problem_id,
          { domainId, executor },
        )
        : null;
    const readable = await evaluateProblemAccess(problem, {
      viewerId: job.actor_id,
      isAdmin: access.platformAdmin,
      contestAccess: job.actor_id === source.user_id ? contestAccess : null,
    }, executor);
    if (!readable.result.allowed) throw new NotFoundError("源题不可使用");
    if (kind === "upgrade") {
      const originalAccess = await evaluateProblemAccess(problem, {
        viewerId: source.user_id,
        isAdmin: false,
        contestAccess,
      }, executor);
      if (!originalAccess.result.allowed) {
        throw new AppError(
          "原用户已无题目访问资格",
          403,
          "UPGRADE_ACCESS_DENIED",
        );
      }
    }
    answerVersion = problem.effective_version_mode === "exact"
      ? problem.required_version_id
      : problem.latest_version_id;
  }
  if (kind === "upgrade" && request.context !== "source_contest") {
    await assertDomainPracticeAllowed(
      domainId,
      source.problem_id,
      source.user_id,
      executor,
    );
    if (
      item.target_version_id !==
        answerVersion
    ) {
      throw new AppError(
        "作答版本已变化，请重新创建升级任务",
        409,
        "UPGRADE_TARGET_VERSION_CHANGED",
      );
    }
  }
}
