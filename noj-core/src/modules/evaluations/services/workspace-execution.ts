import { asc, eq, inArray } from "drizzle-orm";
import { AppError } from "../../../shared/base/errors.ts";
import type { AssignmentSubmissionOrigin } from "../../../shared/education-types.ts";
import { resolveAssignmentSubmissionOrigin } from "../../education/contracts/cross-module/services_assignment-submission-origin.ts";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  domainProblemBindings,
  domains,
  problems,
} from "../../../shared/db/schema.ts";
import { resolveDomainProblem } from "../../problems/contracts/cross-module/services_workspace_problem-binding-access.ts";
import { assertDomainPracticeAllowed } from "../../contests/contracts/cross-module/services_practice-admission.ts";
import { getDomainContestSubmissionTarget } from "../../contests/contracts/cross-module/services_domain-content.ts";

/** URL 使用域和人类可读引用；不接受客户端传入绑定或源域覆盖。 */
export interface DomainExecutionRequest {
  slug: string;
  reference: string;
  /** 仅比赛路径设置；reference 在此上下文表示赛题标签。 */
  contestId?: string;
  assignment?: AssignmentSubmissionOrigin;
}

/** 解析使用域及当前作答版本；旧编辑内容保留给客户端重新确认。 */
export async function resolveDomainExecution(
  request: DomainExecutionRequest,
  userId: string,
  versionId: string | undefined,
  executor: Executor = getDb(),
) {
  const contestTarget = request.contestId
    ? await getDomainContestSubmissionTarget(
      request.slug,
      request.contestId,
      request.reference,
      userId,
      executor,
    )
    : null;
  const resolved = await resolveDomainProblem(
    request.slug,
    contestTarget?.reference ?? request.reference,
    userId,
    {
      executor,
      write: true,
      // 作答仅重读政策；保持 admission 已持有的共享锁，避免 SHARE 升级死锁。
      domainLock: "share",
      contestId: contestTarget?.contestId,
    },
  );
  if (!versionId) {
    throw new AppError("提交必须携带 version_id", 409, "VERSION_REQUIRED");
  }
  if (versionId !== resolved.version.id) {
    throw new AppError(
      "作答版本已变化，请刷新并确认后重新提交",
      409,
      contestTarget
        ? "CONTEST_PROBLEM_VERSION_CHANGED"
        : "PROBLEM_ANSWER_VERSION_CHANGED",
      {
        expected_version_id: resolved.version.id,
        submitted_version_id: versionId,
      },
    );
  }
  if (!contestTarget) {
    await assertDomainPracticeAllowed(
      resolved.domain.id,
      resolved.problem.id,
      userId,
      executor,
    );
  }
  return { ...resolved, contestId: contestTarget?.contestId };
}

/** 外部 IO 后在同一事务重新授权；锁住撤销、下架和版本策略的写入依据。 */
export async function lockDomainExecution(
  initial: Awaited<ReturnType<typeof resolveDomainExecution>>,
  request: DomainExecutionRequest,
  userId: string,
  versionId: string | undefined,
  executor: Executor,
) {
  // 与域配置写入一致：先域、再源题、再绑定。跨域行按稳定 ID 排序。
  await executor.select({ id: domains.id }).from(domains).where(
    inArray(domains.id, [...new Set([initial.domain.id, initial.source.id])]),
  ).orderBy(asc(domains.id)).for("share");
  await executor.select({ id: problems.id }).from(problems)
    .where(eq(problems.id, initial.problem.id)).for("share");
  await executor.select({ id: domainProblemBindings.id }).from(
    domainProblemBindings,
  )
    .where(eq(domainProblemBindings.id, initial.binding.id)).for("share");
  const current = await resolveDomainExecution(
    request,
    userId,
    versionId,
    executor,
  );
  return {
    domain_id: current.domain.id,
    domain_problem_binding_id: current.binding.id,
    ...await resolveAssignmentSubmissionOrigin(executor, {
      domainId: current.domain.id,
      actorId: userId,
      bindingId: current.binding.id,
      problemId: current.problem.id,
      origin: request.assignment,
    }),
  };
}
