import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { domains, problems, selfTests } from "../../../shared/db/schema.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import { loadWorkspace } from "../../workspace/index.ts";
import {
  domainProblemReference,
  loadBindingAvailability,
} from "../../catalog/index.ts";
import { cancelSelfTest, getSelfTest } from "./self-tests.ts";

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
