import { and, eq, inArray } from "drizzle-orm";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  domainProblemBindings,
  problems,
} from "../../../../shared/db/schema.ts";
import {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
  ensureDefaultWorkspace,
  loadWorkspace,
} from "../../../workspace/index.ts";

/** 在准备下载或 LLM 令牌前拒绝用旧入口执行其他域的源题。 */
export function assertDefaultProblemSource(
  source: { domain_id: string },
) {
  if (source.domain_id !== DEFAULT_DOMAIN_ID) {
    throw new NotFoundError("默认域不存在此题");
  }
}

/** 旧执行入口只使用默认域，受理时必须具有本域题库绑定。 */
export async function resolveDefaultExecutionContext(
  problemId: string,
  actorId: string,
  executor: Executor,
) {
  const contexts = await resolveDefaultExecutionContexts(
    [problemId],
    actorId,
    executor,
  );
  const context = contexts.get(problemId);
  if (!context) throw new NotFoundError("默认域不存在此题");
  return context;
}

/** 批量任务一次解析源题与绑定，不为每个条目单独查询域设置。 */
export async function resolveDefaultExecutionContexts(
  problemIds: readonly string[],
  actorId: string,
  executor: Executor,
) {
  await ensureDefaultWorkspace(executor);
  await loadWorkspace(DEFAULT_DOMAIN_SLUG, actorId, {
    executor,
    write: true,
    lock: "share",
  });
  const contexts = new Map<
    string,
    { domain_id: string; domain_problem_binding_id: string }
  >();
  const ids = [...new Set(problemIds)];
  // 大任务按固定批次读取，避免 PostgreSQL 参数上限；域行锁只获取一次。
  for (let offset = 0; offset < ids.length; offset += 500) {
    const sources = await executor.select({
      id: problems.id,
      domain_id: problems.domain_id,
      binding_id: domainProblemBindings.id,
      disabled_at: domainProblemBindings.disabled_at,
    })
      .from(problems).leftJoin(
        domainProblemBindings,
        and(
          eq(domainProblemBindings.domain_id, DEFAULT_DOMAIN_ID),
          eq(domainProblemBindings.problem_id, problems.id),
          eq(domainProblemBindings.kind, "owned"),
        ),
      )
      .where(inArray(problems.id, ids.slice(offset, offset + 500)));
    for (const source of sources) {
      assertDefaultProblemSource(source);
      if (!source.binding_id || source.disabled_at) {
        throw new NotFoundError("默认域不存在可使用的题库绑定");
      }
      contexts.set(source.id, {
        domain_id: DEFAULT_DOMAIN_ID,
        domain_problem_binding_id: source.binding_id,
      });
    }
  }
  return contexts;
}
