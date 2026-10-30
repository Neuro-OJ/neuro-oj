import { and, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import type { DbTx } from "../../../../shared/db/executor.ts";
import {
  domainProblemBindings,
  domains,
  problems,
  problemShareSettings,
  problemShareTargets,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";
import {
  guestActor,
  userActorFromAuthenticatedId,
} from "../../../access/contracts/actor.ts";
import { loadWorkspaceTx } from "../../../access/policy.ts";
import { loadPublicContestSecrecy } from "../../../contests/contracts/read.ts";
import { verifyContestAccess } from "../../../access/contest-policy.ts";
import {
  domainProblemReference,
  parseDomainProblemReference,
} from "./problem-reference.ts";

function isDbTx(executor: Executor): executor is DbTx {
  return "rollback" in executor && "setTransaction" in executor &&
    "nestedIndex" in executor;
}

export function legacyWorkspaceFromAccess(
  result: Awaited<ReturnType<typeof loadWorkspaceTx>>,
) {
  return {
    domain: result.domain,
    membership: result.membership,
    platformAdmin: result.platformAdmin,
    context: {
      domainId: result.context.domainId,
      domainSlug: result.context.domainSlug,
      actorId: result.context.actor.kind === "user"
        ? result.context.actor.userId
        : null,
      platformPermissions: result.context.platformPermissions,
      domainPermissions: result.context.domainPermissions,
      domainRevision: result.context.domainRevision,
    },
  };
}

/** 跨域引用实时读取当前源授权；目标域管理员也不能绕过撤销。 */
export async function assertCurrentProblemShare(
  problem: typeof problems.$inferSelect,
  source: typeof domains.$inferSelect,
  targetDomainId: string,
  executor: Executor = getDb(),
) {
  if (
    source.status === "suspended" || source.configuration.access !== "public" ||
    problem.visibility !== "public" || !problem.latest_version_id
  ) {
    throw new NotFoundError("源题不可引用或共享授权已撤销");
  }
  const [sourceBinding] = await executor.select({
    id: domainProblemBindings.id,
  })
    .from(domainProblemBindings).where(and(
      eq(domainProblemBindings.domain_id, source.id),
      eq(domainProblemBindings.problem_id, problem.id),
      eq(domainProblemBindings.kind, "owned"),
      eq(domainProblemBindings.visibility, "public"),
      isNull(domainProblemBindings.disabled_at),
    ));
  if (!sourceBinding) throw new NotFoundError("源题已下架或源域绑定不可用");
  const [settings] = await executor.select().from(problemShareSettings).where(
    eq(problemShareSettings.problem_id, problem.id),
  );
  if (!settings?.enabled) throw new NotFoundError("源题未开放引用");
  if (settings.scope === "selected") {
    const [grant] = await executor.select().from(problemShareTargets).where(
      and(
        eq(problemShareTargets.problem_id, problem.id),
        eq(problemShareTargets.domain_id, targetDomainId),
      ),
    );
    if (!grant) throw new NotFoundError("源题未授权此工作空间引用");
  }
  if (
    (await loadPublicContestSecrecy(problem.id, executor, source.id)).length
  ) {
    throw new NotFoundError("源题处于比赛保密窗口");
  }
}

/** 内部资源事实解析；返回值不得直接作为公开 API DTO，内容仍须统一裁剪。 */
export async function resolveDomainProblem(
  slug: string,
  reference: string,
  actorId: string | null,
  options: {
    executor?: Executor;
    write?: boolean;
    contestId?: string;
    versionId?: string;
    domainLock?: "share";
  } = {},
) {
  const executor = options.executor ?? getDb();
  const workspace = isDbTx(executor)
    ? legacyWorkspaceFromAccess(
      await loadWorkspaceTx(
        executor,
        slug,
        actorId ? userActorFromAuthenticatedId(actorId) : guestActor(),
        { write: options.write, lock: options.domainLock ?? options.write },
      ),
    )
    : await loadWorkspace(slug, actorId, {
      executor,
      write: options.write,
    });
  return await resolveDomainProblemInWorkspace(workspace, reference, {
    ...options,
    executor,
  });
}

/** 同一事务复用已解析的使用域身份，源题、共享与版本仍逐资源读取。 */
export async function resolveDomainProblemInWorkspace(
  workspace: Awaited<ReturnType<typeof loadWorkspace>>,
  reference: string,
  options: {
    executor: Executor;
    write?: boolean;
    contestId?: string;
    versionId?: string;
  },
) {
  const executor = options.executor;
  const actorId = workspace.context.actorId;
  const parsed = parseDomainProblemReference(reference);
  if (options.write) {
    assertWorkspacePermission(workspace.context, "submission:create");
  }
  const sourceDomains = alias(domains, "source_domains");
  const [row] = await executor.select({
    binding: domainProblemBindings,
    problem: problems,
    source: sourceDomains,
  }).from(domainProblemBindings)
    .innerJoin(problems, eq(problems.id, domainProblemBindings.problem_id))
    .innerJoin(sourceDomains, eq(sourceDomains.id, problems.domain_id))
    .where(
      and(
        eq(domainProblemBindings.domain_id, workspace.domain.id),
        eq(problems.number, parsed.number),
        isNull(domainProblemBindings.disabled_at),
        parsed.sourceSlug
          ? eq(sourceDomains.slug, parsed.sourceSlug)
          : eq(problems.domain_id, workspace.domain.id),
      ),
    );
  if (!row) throw new NotFoundError("域题库中不存在此题");
  if (row.source.id !== workspace.domain.id || row.binding.kind !== "owned") {
    throw new NotFoundError("请先将题目独立复制到当前域");
  }
  const contestAccess = options.contestId
    ? await verifyContestAccess(
      actorId ? userActorFromAuthenticatedId(actorId) : guestActor(),
      options.contestId,
      row.problem.id,
      {
        domainId: workspace.domain.id,
        ...(isDbTx(executor) ? { executor } : {}),
      },
    )
    : null;
  if (
    contestAccess &&
    (!contestAccess.allowed || options.write && !contestAccess.running)
  ) throw new NotFoundError("此赛题不可作答");
  if (
    row.binding.kind !==
      (row.source.id === workspace.domain.id ? "owned" : "shared")
  ) {
    throw new AppError(
      "题库绑定来源不一致",
      503,
      "PROBLEM_BINDING_INCONSISTENT",
    );
  }
  {
    if (!row.problem.latest_version_id) throw new NotFoundError("此题尚未发布");
    const editable = workspace.platformAdmin ||
      workspace.context.domainPermissions.has("problem:write_any") ||
      (actorId === row.problem.owner_id &&
        workspace.context.domainPermissions.has("problem:write_own"));
    const protection = await loadPublicContestSecrecy(
      row.problem.id,
      executor,
      row.source.id,
    );
    if (
      protection.length && !contestAccess?.allowed &&
      (!editable || options.write)
    ) {
      throw new ForbiddenError(
        "此题受比赛保护，请在开赛后报名并从比赛入口作答",
        "CONTEST_PROBLEM_RESTRICTED",
        { contests: protection },
      );
    }
  }
  const answerVersionId = contestAccess?.pinnedVersionId ??
    (row.problem.effective_version_mode === "exact"
      ? row.problem.required_version_id
      : row.problem.latest_version_id);
  const versionId = contestAccess
    ? answerVersionId
    : options.versionId ?? answerVersionId;
  const [version] = versionId
    ? await executor.select().from(problemVersions).where(
      and(
        eq(problemVersions.id, versionId),
        eq(problemVersions.problem_id, row.problem.id),
      ),
    )
    : [];
  if (!version) throw new NotFoundError("题目作答版本不可用");
  return {
    ...workspace,
    ...row,
    binding: {
      ...row.binding,
      effective_version_mode: row.problem.effective_version_mode as
        | "any"
        | "exact",
      required_version_id: row.problem.required_version_id,
    },
    version,
    answerVersionId,
    reference: domainProblemReference(
      { ...row.problem, domain_id: row.source.id },
      row.source.slug,
      workspace.domain.id,
    ),
  };
}
