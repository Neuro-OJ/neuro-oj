import {
  and,
  asc,
  count,
  eq,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domainProblemBindings,
  domains,
  problems,
  problemShareSettings,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import { loadWorkspace } from "../../../workspace/index.ts";
import { unendedPublicContestForProblem } from "../../../contest/index.ts";
import type { ProblemContentV1 } from "../../types/problem-content.ts";
import { trimProblemContentForViewer } from "../versioning/version-read-view.ts";
import { resolveDomainProblem } from "./problem-binding-access.ts";
import { domainProblemReference } from "./problem-reference.ts";

/** 域题库分页：授权、共享撤销及比赛保密都在分页和计数前过滤。 */
export async function listDomainProblems(
  slug: string,
  actorId: string | null,
  query: { page: number; limit: number; keyword?: string },
) {
  const db = getDb();
  const workspace = await loadWorkspace(slug, actorId);
  const source = alias(domains, "problem_source_domain");
  const binding = domainProblemBindings;
  const canEdit = workspace.platformAdmin ||
    workspace.context.domainPermissions.has("problem:write_any");
  const visible = and(
    eq(binding.domain_id, workspace.domain.id),
    isNull(binding.disabled_at),
    workspace.membership || workspace.platformAdmin
      ? undefined
      : eq(binding.visibility, "public"),
    isNotNull(problems.latest_version_id),
    or(
      and(
        eq(binding.kind, "owned"),
        eq(problems.domain_id, workspace.domain.id),
        canEdit ? undefined : or(
          sql`NOT ${unendedPublicContestForProblem(problems.id)}`,
          actorId &&
            workspace.context.domainPermissions.has("problem:write_own")
            ? eq(problems.owner_id, actorId)
            : undefined,
        ),
      ),
      and(
        eq(binding.kind, "shared"),
        eq(problems.visibility, "public"),
        sql`${source.status} <> 'suspended'`,
        sql`${source.configuration}->>'access' = 'public'`,
        eq(problemShareSettings.enabled, true),
        sql`(${problemShareSettings.scope} = 'all' OR EXISTS (SELECT 1 FROM problem_share_targets grant_target WHERE grant_target.problem_id = ${problems.id} AND grant_target.domain_id = ${workspace.domain.id}))`,
        sql`EXISTS (SELECT 1 FROM domain_problem_bindings source_binding WHERE source_binding.problem_id = ${problems.id} AND source_binding.domain_id = ${source.id} AND source_binding.kind = 'owned' AND source_binding.disabled_at IS NULL)`,
        sql`NOT ${unendedPublicContestForProblem(problems.id)}`,
      ),
    ),
    query.keyword
      ? ilike(sql`${problemVersions.content}->>'title'`, `%${query.keyword}%`)
      : undefined,
  );
  const join = () =>
    db.select({
      problem_id: problems.id,
      source_domain_id: source.id,
      source_slug: source.slug,
      number: problems.number,
      title: sql<string>`${problemVersions.content}->>'title'`,
      kind: sql<string>`${problemVersions.content}->>'kind'`,
      version_id: problemVersions.id,
      version: problemVersions.version,
      binding_id: binding.id,
      revision: binding.revision,
    }).from(binding).innerJoin(problems, eq(problems.id, binding.problem_id))
      .innerJoin(source, eq(source.id, problems.domain_id))
      .innerJoin(
        problemVersions,
        and(
          eq(problemVersions.problem_id, problems.id),
          eq(
            problemVersions.id,
            sql`CASE WHEN ${binding.effective_version_mode} = 'exact' THEN ${binding.required_version_id} ELSE ${problems.latest_version_id} END`,
          ),
        ),
      )
      .leftJoin(
        problemShareSettings,
        eq(problemShareSettings.problem_id, problems.id),
      ).where(visible);
  const candidates = join().as("authorized_domain_problems");
  const [[total], rows] = await Promise.all([
    db.select({ total: count() }).from(candidates),
    join().orderBy(asc(source.slug), asc(problems.number), asc(problems.id))
      .limit(query.limit).offset((query.page - 1) * query.limit),
  ]);
  return {
    page: query.page,
    limit: query.limit,
    total: total.total,
    items: rows.map((row) => ({
      reference: domainProblemReference(
        {
          id: row.problem_id,
          domain_id: row.source_domain_id,
          number: row.number,
        },
        row.source_slug,
        workspace.domain.id,
      ),
      title: row.title,
      kind: row.kind,
      version_id: row.version_id,
      version: row.version,
      binding_id: row.binding_id,
      policy_revision: row.revision,
    })),
  };
}

/** 读取目标域选择的不可变版本；目标域管理员不能获得共享题的评测配置与答案。 */
export async function readDomainProblem(
  slug: string,
  reference: string,
  actorId: string | null,
) {
  const resolved = await resolveDomainProblem(slug, reference, actorId);
  const canEdit = resolved.binding.kind === "owned" &&
    (resolved.platformAdmin ||
      resolved.context.domainPermissions.has("problem:write_any") ||
      actorId === resolved.problem.owner_id &&
        resolved.context.domainPermissions.has("problem:write_own"));
  return {
    reference: resolved.reference,
    binding_id: resolved.binding.id,
    policy_revision: resolved.binding.revision,
    effective_version_mode: resolved.binding.effective_version_mode,
    version_id: resolved.version.id,
    version: resolved.version.version,
    can_edit: canEdit,
    content: trimProblemContentForViewer(
      resolved.version.content as ProblemContentV1,
      canEdit,
    ),
  };
}
