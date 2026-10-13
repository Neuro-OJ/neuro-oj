import { getDb } from "../../../../shared/db/connection.ts";
import { assertCommunityWritable } from "./community-config.ts";
import { type CommunityScope, loadCommunityScope } from "./community-scope.ts";

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
