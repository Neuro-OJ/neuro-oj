import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  domainCreationRequests,
  domains,
  users,
} from "../../../shared/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import type { DomainPreset } from "../../../shared/workspace/types.ts";
import { getUserPermissions } from "../../identity/index.ts";
import { validateDomainSlug } from "../types.ts";
import { createDomain, workspaceAudit } from "./domains.ts";
import { getInstanceAccessPolicy } from "./instance.ts";

/** 申请创建与申请加入分开；同一用户同一标识的待审申请幂等复用。 */
export async function requestDomainCreation(
  actorId: string,
  input: { slug: string; name: string; preset: DomainPreset; reason: string },
) {
  validateDomainSlug(input.slug);
  if (getInstanceAccessPolicy().domain_creation_policy !== "approval") {
    throw new ForbiddenError("实例未启用工作空间创建申请");
  }
  if (
    typeof input.name !== "string" || !input.name.trim() ||
    input.name.length > 100 || typeof input.reason !== "string" ||
    !input.reason.trim() || input.reason.length > 2000 ||
    !["community", "education", "team", "custom"].includes(input.preset)
  ) throw new BadRequestError("申请内容非法");
  return await getDb().transaction(async (tx) => {
    const [actor] = await tx.select().from(users).where(
      and(eq(users.id, actorId), isNull(users.deleted_at)),
    ).for("update");
    if (!actor?.email_verified) throw new ForbiddenError("请先验证邮箱");
    const [existing] = await tx.select().from(domainCreationRequests).where(
      and(
        eq(domainCreationRequests.applicant_id, actorId),
        eq(domainCreationRequests.slug, input.slug),
        eq(domainCreationRequests.status, "pending"),
      ),
    );
    if (existing) return existing;
    const [domain] = await tx.select({ id: domains.id }).from(domains).where(
      eq(domains.slug, input.slug),
    );
    if (domain) throw new ConflictError("工作空间标识已存在");
    const [request] = await tx.insert(domainCreationRequests).values({
      id: crypto.randomUUID(),
      applicant_id: actorId,
      slug: input.slug,
      name: input.name.trim(),
      preset: input.preset,
      reason: input.reason.trim(),
      created_at: new Date().toISOString(),
    }).returning();
    return request;
  });
}

/** 平台审核批准与建域同时提交，重复审批不重复创建。 */
export async function reviewDomainCreation(
  requestId: string,
  actorId: string,
  approved: boolean,
) {
  return await getDb().transaction(async (tx) => {
    if (!(await getUserPermissions(actorId, tx)).has("admin:full_access")) {
      throw new ForbiddenError("需要平台管理权限");
    }
    const [request] = await tx.select().from(domainCreationRequests).where(
      eq(domainCreationRequests.id, requestId),
    ).for("update");
    if (!request) throw new NotFoundError("申请不存在");
    if (request.status !== "pending") throw new ConflictError("申请已经处理");
    const domain = approved
      ? await createDomain(
        { slug: request.slug, name: request.name, preset: request.preset },
        request.applicant_id,
        { executor: tx, approved: true },
      )
      : null;
    const [updated] = await tx.update(domainCreationRequests).set({
      status: approved ? "approved" : "rejected",
      domain_id: domain?.id ?? null,
      reviewed_by: actorId,
      reviewed_at: new Date().toISOString(),
    }).where(eq(domainCreationRequests.id, requestId)).returning();
    await workspaceAudit(tx, actorId, domain?.id ?? null, "domain.update", {
      operation: "creation_request_review",
      approved,
      applicant_id: request.applicant_id,
      requested_slug: request.slug,
    }, { type: "domain_creation_request", id: request.id });
    return updated;
  });
}
