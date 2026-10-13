import { getDb } from "../../../../shared/db/connection.ts";
import { assertCommunityWritable } from "./community-config.ts";
import { type CommunityScope, loadCommunityScope } from "./community-scope.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../workspace/index.ts";

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
  for (const callback of result.afterCommit) callback();
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
  for (const callback of result.afterCommit) callback();
  return result.value;
}
