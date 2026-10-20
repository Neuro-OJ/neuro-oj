import { and, count, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domainProblemBindings,
  problemDrafts,
  problems,
} from "../../../../shared/db/schema.ts";
import { loadWorkspace, workspaceAudit } from "../../../../domains/workspace/index.ts";
import { domainProblemReference } from "./problem-reference.ts";

/** 可编辑源题草稿目录，包括尚未发布题目；不返回源内容或共享引用。 */
export async function listEditableDomainProblemDrafts(
  slug: string,
  actorId: string,
  page = 1,
  limit = 20,
) {
  const access = await loadWorkspace(slug, actorId), db = getDb();
  const any = access.platformAdmin ||
    access.context.domainPermissions.has("problem:write_any");
  const own = access.context.domainPermissions.has("problem:write_own");
  const condition = and(
    eq(problems.domain_id, access.domain.id),
    eq(domainProblemBindings.domain_id, access.domain.id),
    eq(domainProblemBindings.kind, "owned"),
    isNull(domainProblemBindings.disabled_at),
    any ? undefined : own ? eq(problems.owner_id, actorId) : sql`false`,
  );
  const [totals, rows] = await Promise.all([
    db.select({ total: count() }).from(problems).innerJoin(
      domainProblemBindings,
      eq(domainProblemBindings.problem_id, problems.id),
    ).where(condition),
    db.select({
      id: problems.id,
      number: problems.number,
      title: sql<
        string
      >`COALESCE(${problemDrafts.content}->>'title',${problems.title})`,
      revision: problemDrafts.revision,
      base_version_id: problemDrafts.base_version_id,
      latest_version_id: problems.latest_version_id,
      updated_at: problemDrafts.updated_at,
    }).from(problems)
      .innerJoin(
        domainProblemBindings,
        eq(domainProblemBindings.problem_id, problems.id),
      ).leftJoin(problemDrafts, eq(problemDrafts.problem_id, problems.id))
      .where(condition).orderBy(problems.number).limit(limit).offset(
        (page - 1) * limit,
      ),
  ]);
  if (access.platformAdmin) {
    await workspaceAudit(db, actorId, access.domain.id, "domain.update", {
      operation: "problem.draft_list_access",
    });
  }
  return {
    items: rows.map((row) => ({
      reference: domainProblemReference(
        { id: row.id, number: row.number, domain_id: access.domain.id },
        access.domain.slug,
        access.domain.id,
      ),
      title: row.title,
      draft_revision: row.revision ?? 0,
      base_version_id: row.base_version_id ?? row.latest_version_id,
      updated_at: row.updated_at,
    })),
    total: totals[0].total,
    page,
    limit,
  };
}
