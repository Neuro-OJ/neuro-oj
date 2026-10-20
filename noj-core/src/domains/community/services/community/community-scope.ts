import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  publishSearchIndexEvent,
  type SearchIndexAction,
} from "../../../../shared/search-events.ts";
import {
  communityPosts,
  domainProblemBindings,
  domains,
  problems,
} from "../../../../shared/db/schema.ts";
import {
  domainProblemBindingAvailableWhere,
  resolveDomainProblem,
} from "../../../../modules/problems/index.ts";
import {
  assertDomainFeatureEnabled,
  assertWorkspacePermission,
  DEFAULT_DOMAIN_ID,
  loadWorkspace,
  workspaceAudit,
} from "../../../workspace/index.ts";

/** 已授权的域社区请求事实；只在当前事务及调用链中传递，不写入 JWT。 */
export interface CommunityScope {
  domainId: string;
  slug: string;
  actorId: string | null;
  member: boolean;
  moderator: boolean;
  executor: Executor;
  afterCommit: (() => void)[];
}

/** 显式域入口重新检查账号、域成员、模块配置及当前治理能力。 */
export async function loadCommunityScope(
  slug: string,
  actorId: string | null,
  options: { executor?: Executor; write?: boolean; permission?: string } = {},
): Promise<CommunityScope> {
  const executor = options.executor ?? getDb();
  const access = await loadWorkspace(slug, actorId, {
    executor,
    write: options.write,
    lock: options.write ? "share" : undefined,
  });
  await assertDomainFeatureEnabled(access.domain, "community", { executor });
  if (options.permission) {
    assertWorkspacePermission(access.context, options.permission);
  }
  const moderator = access.platformAdmin ||
    access.context.domainPermissions.has("community:moderate");
  if (access.platformAdmin && actorId) {
    await workspaceAudit(executor, actorId, access.domain.id, "domain.update", {
      operation: options.write
        ? "community.write_access"
        : "community.read_access",
    });
  }
  return {
    domainId: access.domain.id,
    slug,
    actorId,
    member: !!access.membership || access.platformAdmin,
    moderator,
    executor,
    afterCommit: [],
  };
}

/** 旧无域服务固定默认域；NULL 只用于迁移扩展期的旧记录。 */
export function communityDomainWhere(
  column: AnyPgColumn,
  scope?: CommunityScope,
) {
  return scope
    ? eq(column, scope.domainId)
    : or(eq(column, DEFAULT_DOMAIN_ID), isNull(column))!;
}

/** 当前域 ID 用于比赛、提交门槛和其他资源授权条件。 */
export function communityDomainId(scope?: CommunityScope) {
  return scope?.domainId ?? DEFAULT_DOMAIN_ID;
}

/** 同一请求的数据库操作共享授权事务。 */
export function communityDb(scope?: CommunityScope) {
  return scope?.executor ?? getDb();
}

/** 索引消费者只能读取已提交内容；回滚的授权事务不发送消息。 */
export function publishCommunitySearchEvent(
  entityType: "community_post" | "community_comment",
  entityId: string,
  action: SearchIndexAction,
  scope?: CommunityScope,
): void {
  const publish = () => {
    void publishSearchIndexEvent(entityType, entityId, action);
  };
  if (scope) scope.afterCommit.push(publish);
  else publish();
}

/** 内部题目 ID 与来源题号都必须先定位到当前域的有效绑定。 */
export async function resolveCommunityProblem(
  reference: string,
  scope: CommunityScope,
) {
  if (scope.slug === "main" && /^P\d+$/.test(reference)) {
    reference = reference.slice(1);
  }
  const [source] = await scope.executor.select({
    number: problems.number,
    slug: domains.slug,
  })
    .from(domainProblemBindings).innerJoin(
      problems,
      eq(problems.id, domainProblemBindings.problem_id),
    )
    .innerJoin(domains, eq(domains.id, problems.domain_id))
    .where(
      and(
        eq(domainProblemBindings.domain_id, scope.domainId),
        eq(problems.id, reference),
      ),
    );
  return await resolveDomainProblem(
    scope.slug,
    source ? `${source.slug}:${source.number}` : reference,
    scope.actorId,
    { executor: scope.executor },
  );
}

/** 列表、计数及通知在分页前检查源授权，失效引用不通过索引延迟继续展示。 */
export function communityResourceVisible(scope?: CommunityScope) {
  return or(
    isNull(communityPosts.problem_id),
    scope ? undefined : isNull(communityPosts.domain_problem_binding_id),
    domainProblemBindingAvailableWhere(
      communityPosts.domain_problem_binding_id,
      sql`${communityDomainId(scope)}`,
      { member: scope?.member ?? false },
    ),
  )!;
}
