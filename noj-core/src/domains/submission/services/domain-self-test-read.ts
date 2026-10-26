import type { Context } from "hono";
import { and, count, desc, eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { domains, problems, selfTests } from "../../../shared/db/schema.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import { loadWorkspace } from "../../workspace/index.ts";
import {
  domainProblemReference,
  loadBindingAvailability,
  resolveDomainProblem,
} from "../../catalog/index.ts";
import { assertDomainPracticeAllowed } from "../../contest/index.ts";
import { cancelSelfTest, getSelfTest } from "./self-tests.ts";

/** 当前使用域题目下的本人自测目录；只投影列表字段，代码及结果详情按需读取。 */
export async function listDomainSelfTests(
  slug: string,
  reference: string,
  actorId: string,
  page: number,
  perPage: number,
) {
  const db = getDb();
  const resource = await resolveDomainProblem(slug, reference, actorId);
  await assertDomainPracticeAllowed(
    resource.domain.id,
    resource.problem.id,
    actorId,
    db,
  );
  const where = and(
    eq(selfTests.domain_id, resource.domain.id),
    eq(selfTests.problem_id, resource.problem.id),
    eq(selfTests.user_id, actorId),
  );
  const [rows, [total]] = await Promise.all([
    db.select({
      id: selfTests.id,
      domain_id: selfTests.domain_id,
      language: selfTests.language,
      version_id: selfTests.problem_version_id,
      status: selfTests.status,
      result_status: selfTests.result_status,
      score: selfTests.score,
      created_at: selfTests.created_at,
    }).from(selfTests).where(where).orderBy(
      desc(selfTests.created_at),
      desc(selfTests.id),
    )
      .limit(perPage).offset((page - 1) * perPage),
    db.select({ value: count() }).from(selfTests).where(where),
  ]);
  return { data: rows, total: total.value };
}

async function accessSelfTest(slug: string, id: string, actorId: string) {
  const workspace = await loadWorkspace(slug, actorId);
  const [metadata] = await getDb().select({
    row: selfTests,
    problem: problems,
    source: domains,
  })
    .from(selfTests).innerJoin(problems, eq(problems.id, selfTests.problem_id))
    .innerJoin(domains, eq(domains.id, problems.domain_id))
    .where(
      and(eq(selfTests.id, id), eq(selfTests.domain_id, workspace.domain.id)),
    );
  const manager = workspace.platformAdmin ||
    workspace.context.domainPermissions.has("submission:read_all");
  if (!metadata || metadata.row.user_id !== actorId && !manager) {
    throw new NotFoundError("自测不存在");
  }
  return { ...workspace, ...metadata, manager };
}

/** 使用域自测读取复用 OI 允许字段投影，源撤销后仅保留原输入和成绩摘要。 */
export async function getDomainSelfTest(
  slug: string,
  id: string,
  actorId: string,
  context: Context,
) {
  const access = await accessSelfTest(slug, id, actorId);
  await assertDomainPracticeAllowed(
    access.domain.id,
    access.problem.id,
    actorId,
    getDb(),
  );
  const detail = await getSelfTest(id, context, {
    domainId: access.domain.id,
    canReadDetails: access.manager,
  });
  const [binding] = await loadBindingAvailability(
    getDb(),
    access.domain.id,
    access.row.domain_problem_binding_id
      ? [access.row.domain_problem_binding_id]
      : [],
  );
  const available = binding?.available === true;
  const projected = { ...detail };
  if (!available) {
    projected.output = null;
    projected.output_truncated = null;
    projected.details = null;
    delete projected.progress;
  }
  return {
    ...projected,
    domain_id: access.domain.id,
    domain_problem_binding_id: access.row.domain_problem_binding_id,
    reference: domainProblemReference(
      { ...access.problem, domain_id: access.source.id },
      access.source.slug,
      access.domain.id,
    ),
    resource_available: available,
    version_id: access.row.problem_version_id,
    assignment_origin: access.row.assignment_id
      ? {
        assignment_id: access.row.assignment_id,
        assignment_item_id: access.row.assignment_item_id!,
      }
      : null,
  };
}

/** 取消不产生新评测，仍验证当前路径域与读取权限，再复用共享取消信号。 */
export async function cancelDomainSelfTest(
  slug: string,
  id: string,
  actorId: string,
  context: Context,
) {
  const access = await accessSelfTest(slug, id, actorId);
  await cancelSelfTest(id, context, {
    domainId: access.domain.id,
    canReadDetails: access.manager,
  });
}
