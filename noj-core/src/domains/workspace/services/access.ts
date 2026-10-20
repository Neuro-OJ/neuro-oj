/**
 * 旧 workspace 路径兼容适配器。
 *
 * 业务实现已迁移到 `modules/access/policy.ts`。这里暂时保留旧的 string
 * 参数和 `Executor` 形状，供尚未迁移的域调用方逐步切换；新代码必须从
 * `modules/access` 使用显式 Actor 与 `DbRoot`/`DbTx` 合同。
 */
import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { DbTx, Executor } from "../../../shared/db/executor.ts";
import {
  ForbiddenError,
  ServiceUnavailableError,
} from "../../../shared/base/errors.ts";
import type { WorkspaceContext } from "../../../shared/workspace/types.ts";
import {
  guestActor,
  userActorFromAuthenticatedId,
} from "../../../modules/access/contracts/actor.ts";
import {
  loadDomainForJoiningTx,
  loadWorkspace as loadAccessWorkspace,
  loadWorkspaceTx,
} from "../../../modules/access/policy.ts";

function actorFor(id: string | null) {
  return id ? userActorFromAuthenticatedId(id) : guestActor();
}

/**
 * Drizzle 的事务句柄本身也暴露 `transaction` 方法，不能用属性存在性把
 * `DbTx` 当成 `DbRoot`。迁移期兼容层只把 getDb() 的单例视为根连接；所有
 * 其它执行器都必须沿用当前事务，避免嵌套事务在已持锁的写用例中死锁。
 */
function isRootDb(executor: Executor): executor is ReturnType<typeof getDb> {
  return executor === getDb();
}

function mapContext(
  result: Awaited<ReturnType<typeof loadAccessWorkspace>>,
): WorkspaceContext {
  return {
    domainId: result.context.domainId,
    domainSlug: result.context.domainSlug,
    actorId: result.context.actor.kind === "user"
      ? result.context.actor.userId
      : null,
    platformPermissions: result.context.platformPermissions,
    domainPermissions: result.context.domainPermissions,
    domainRevision: result.context.domainRevision,
  };
}

/** 跨域目录在数据库分页前检查当前成员关系。 */
export function domainMemberWhere(
  domainId: AnyColumn | SQL,
  actorId: string | null,
): SQL {
  return sql`EXISTS (SELECT 1 FROM domain_memberships access_member WHERE access_member.domain_id=${domainId}
    AND access_member.user_id=${actorId} AND access_member.status='active')`;
}

/** 公共目录及本人可进入的私有域。 */
export function domainReadableWhere(
  domainId: AnyColumn | SQL,
  actorId: string | null,
  platformAdmin = false,
): SQL {
  return sql`EXISTS (SELECT 1 FROM domains access_domain WHERE access_domain.id=${domainId} AND
    (${platformAdmin} OR (access_domain.status<>'suspended' AND
      (access_domain.configuration->>'access'='public' OR ${
    domainMemberWhere(domainId, actorId)
  }))))`;
}

/**
 * 旧调用方的访问读取适配。带锁的调用只能传真实 DbTx；根连接回退到新
 * 只读入口，避免在深层 helper 重新开启事务。
 */
export async function loadWorkspace(
  slug: string,
  actorId: string | null,
  options: {
    write?: boolean;
    lock?: boolean | "share";
    executor?: Executor;
  } = {},
) {
  const actor = actorFor(actorId);
  const executor = options.executor;
  const result = executor
    ? isRootDb(executor)
      ? await getDb().transaction((tx) =>
        loadWorkspaceTx(tx, slug, actor, {
          write: options.write,
          lock: options.lock,
        })
      )
      : await loadWorkspaceTx(executor as DbTx, slug, actor, {
        write: options.write,
        lock: options.lock,
      })
    : await loadAccessWorkspace(slug, actor, { write: options.write });
  return {
    domain: result.domain,
    membership: result.membership,
    context: mapContext(result),
    platformAdmin: result.platformAdmin,
  };
}

/** 旧 context 仅作兼容映射；新业务使用 modules/access 的显式 context。 */
export function assertWorkspacePermission(
  context: WorkspaceContext,
  permission: string,
): void {
  if (
    !context.actorId ||
    !context.platformPermissions.has("admin:full_access") &&
      !context.domainPermissions.has(permission)
  ) throw new ForbiddenError("工作空间权限不足", "DOMAIN_PERMISSION_DENIED");
}

/** 旧加入读取适配；写入实现由 modules/access/members.ts 持有。 */
export async function loadDomainForJoining(
  slug: string,
  executor?: Executor,
) {
  const domain = executor
    ? isRootDb(executor)
      ? await getDb().transaction((tx) => loadDomainForJoiningTx(tx, slug))
      : await loadDomainForJoiningTx(executor as DbTx, slug)
    : await getDb().transaction((tx) => loadDomainForJoiningTx(tx, slug));
  if (
    domain.configuration?.access !== "public" &&
    domain.configuration?.access !== "members"
  ) {
    throw new ServiceUnavailableError("工作空间访问政策无效，请联系管理员修复");
  }
  if (
    !["open", "approval", "invite"].includes(domain.configuration.join_policy)
  ) {
    throw new ServiceUnavailableError("工作空间加入政策无效，请联系管理员修复");
  }
  return domain;
}
