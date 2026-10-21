import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import {
  BadRequestError,
  ForbiddenError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  domainCreationRequests,
  domains,
  users,
} from "../../../../shared/db/schema.ts";
import {
  buildPaginationMeta,
  type Pagination,
} from "../../../../shared/http/pagination.ts";
import { assertActiveInstanceAccount } from "../../identity/services/security/account-access.ts";
import { getUserPermissions } from "../../identity/services/security/permissions.ts";

async function assertPlatformGovernance(actorId: string, executor: Executor) {
  await assertActiveInstanceAccount(actorId, executor);
  if (!(await getUserPermissions(actorId, executor)).has("admin:full_access")) {
    throw new ForbiddenError("需要平台管理权限");
  }
}

/** 平台目录包含私有与暂停域，不能用普通发现列表替代治理视图。 */
export async function listAdminDomains(
  actorId: string,
  pagination: Pagination,
  filters: { status?: string; keyword?: string } = {},
) {
  const db = getDb();
  await assertPlatformGovernance(actorId, db);
  if (
    filters.status !== undefined &&
    !["active", "archived", "suspended"].includes(filters.status)
  ) {
    throw new BadRequestError("工作空间状态筛选非法");
  }
  const keyword = filters.keyword?.trim();
  if (keyword && keyword.length > 100) {
    throw new BadRequestError("搜索词最多 100 字");
  }
  const pattern = keyword
    ? `%${keyword.replace(/[\\%_]/g, "\\$&")}%`
    : undefined;
  const where = and(
    filters.status
      ? eq(domains.status, filters.status as typeof domains.$inferSelect.status)
      : undefined,
    pattern
      ? or(ilike(domains.name, pattern), ilike(domains.slug, pattern))
      : undefined,
  );
  const [total] = await db.select({ value: count() }).from(domains).where(
    where,
  );
  const rows = await db.select({
    id: domains.id,
    slug: domains.slug,
    name: domains.name,
    description: domains.description,
    owner_id: domains.owner_id,
    owner_username: users.username,
    owner_deleted_at: users.deleted_at,
    status: domains.status,
    preset: domains.preset,
    revision: domains.revision,
    configuration: domains.configuration,
    created_at: domains.created_at,
    updated_at: domains.updated_at,
  }).from(domains).innerJoin(users, eq(users.id, domains.owner_id)).where(where)
    .orderBy(desc(domains.created_at), domains.id).limit(pagination.perPage)
    .offset(pagination.offset);
  return {
    data: rows.map(({ owner_deleted_at, ...row }) => ({
      ...row,
      owner_username: owner_deleted_at ? "已注销用户" : row.owner_username,
    })),
    pagination: buildPaginationMeta(
      pagination.page,
      pagination.perPage,
      total.value,
    ),
  };
}

/** 审核目录按状态分页，注销申请人保留记录但隐藏原账号展示。 */
export async function listDomainCreationRequests(
  actorId: string,
  pagination: Pagination,
  status?: string,
) {
  const db = getDb();
  await assertPlatformGovernance(actorId, db);
  if (
    status !== undefined &&
    !["pending", "approved", "rejected"].includes(status)
  ) {
    throw new BadRequestError("创建申请状态筛选非法");
  }
  const where = status
    ? eq(
      domainCreationRequests.status,
      status as typeof domainCreationRequests.$inferSelect.status,
    )
    : undefined;
  const [total] = await db.select({ value: count() }).from(
    domainCreationRequests,
  ).where(where);
  const rows = await db.select({
    request: domainCreationRequests,
    applicant_username: users.username,
    applicant_deleted_at: users.deleted_at,
  })
    .from(domainCreationRequests).innerJoin(
      users,
      eq(users.id, domainCreationRequests.applicant_id),
    ).where(where)
    .orderBy(desc(domainCreationRequests.created_at), domainCreationRequests.id)
    .limit(pagination.perPage).offset(pagination.offset);
  return {
    data: rows.map(({ request, applicant_username, applicant_deleted_at }) => ({
      ...request,
      applicant_username: applicant_deleted_at
        ? "已注销用户"
        : applicant_username,
      applicant_deleted: !!applicant_deleted_at,
    })),
    pagination: buildPaginationMeta(
      pagination.page,
      pagination.perPage,
      total.value,
    ),
  };
}
