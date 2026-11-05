import { getDb } from "../../../../../shared/db/connection.ts";
import { assertCommunityWritable } from "./community-config.ts";
import { type CommunityScope, loadCommunityScope } from "./community-scope.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../../../shared/workspace/types.ts";
import { runBestEffort } from "../../../../../shared/base/best-effort.ts";

/** 旧社区入口固定 main；旧平台社区权限只在该明确目标内继续生效。 */
export async function withDefaultCommunity<T>(
  actorId: string | null,
  options: { write?: boolean; moderator?: boolean },
  operation: (scope: CommunityScope) => Promise<T>,
): Promise<T> {
  const run = async (executor: CommunityScope["executor"]) => {
    const scope = await loadCommunityScope(DEFAULT_DOMAIN_SLUG, actorId, {
      executor,
      write: options.write,
    });
    scope.moderator ||= options.moderator === true;
    return { value: await operation(scope), afterCommit: scope.afterCommit };
  };
  const result = options.write
    ? await getDb().transaction(run)
    : await run(getDb());
  // 事务已提交：后置回调（通知/索引）按注册顺序执行，单个失败不影响其余，
  // 也不把已提交的写入报成失败。
  for (const [index, callback] of result.afterCommit.entries()) {
    await runBestEffort("community.after_commit", callback, { index });
  }
  return result.value;
}

/** 域社区公开门面：写入在授权事务内复用原 CRUD，避免额外维护一套内容模型。 */
export async function withDomainCommunity<T>(
  slug: string,
  actorId: string | null,
  options: { write?: boolean; permission?: string; allowSocialBan?: boolean },
  operation: (scope: CommunityScope) => Promise<T>,
): Promise<T> {
  const run = async (executor: CommunityScope["executor"]) => {
    const scope = await loadCommunityScope(slug, actorId, {
      ...options,
      executor,
    });
    if (options.write && actorId) {
      await assertCommunityWritable(actorId, scope.moderator, {
        scope,
        allowSocialBan: options.allowSocialBan,
      });
    }
    return { value: await operation(scope), afterCommit: scope.afterCommit };
  };
  const result = options.write
    ? await getDb().transaction(run)
    : await run(getDb());
  // 事务已提交：后置回调（通知/索引）按注册顺序执行，单个失败不影响其余，
  // 也不把已提交的写入报成失败。
  for (const [index, callback] of result.afterCommit.entries()) {
    await runBestEffort("community.after_commit", callback, { index });
  }
  return result.value;
}
