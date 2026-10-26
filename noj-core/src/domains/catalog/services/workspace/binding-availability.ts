import { sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { Executor } from "../../../../shared/db/executor.ts";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";
import { unendedPublicContestForProblem } from "../../../contest/index.ts";

function bindingAvailabilityCondition() {
  return sql`b.disabled_at IS NULL AND p.latest_version_id IS NOT NULL AND src.status <> 'suspended'
    AND EXISTS (SELECT 1 FROM problem_versions v WHERE v.problem_id = p.id
      AND v.id = CASE WHEN b.effective_version_mode = 'exact' THEN b.required_version_id ELSE p.latest_version_id END)
    AND (b.kind = 'owned' OR (src.configuration->>'access' = 'public' AND p.visibility = 'public'
      AND COALESCE(share.enabled, false) AND (share.scope = 'all' OR EXISTS (
        SELECT 1 FROM problem_share_targets t WHERE t.problem_id = p.id AND t.domain_id = b.domain_id))
      AND EXISTS (SELECT 1 FROM domain_problem_bindings owned WHERE owned.domain_id = src.id
        AND owned.problem_id = p.id AND owned.kind = 'owned' AND owned.visibility = 'public' AND owned.disabled_at IS NULL)
      AND NOT ${unendedPublicContestForProblem(sql`p.id`, sql`p.domain_id`)}))`;
}

/** 分页、命中数和收藏在数据库过滤当前绑定授权，不依赖异步索引状态。 */
export function domainProblemBindingAvailableWhere(
  bindingId: AnyColumn | SQL,
  domainId: AnyColumn | SQL,
  options: { member: boolean },
): SQL {
  return availableBindingWhere(
    sql`b.id = ${bindingId}`,
    domainId,
    options.member,
  );
}

/** 搜索直接按源题定位当前可用绑定，避免再次查询同一个题目和绑定。 */
export function domainProblemAvailableWhere(
  problemId: AnyColumn | SQL,
  domainId: AnyColumn | SQL,
  options: { member: boolean },
): SQL {
  return availableBindingWhere(
    sql`b.problem_id = ${problemId}`,
    domainId,
    options.member,
  );
}

function availableBindingWhere(
  selector: SQL,
  domainId: AnyColumn | SQL,
  member: boolean,
): SQL {
  return sql`EXISTS (SELECT 1 FROM domain_problem_bindings b
    JOIN problems p ON p.id = b.problem_id JOIN domains src ON src.id = p.domain_id
    LEFT JOIN problem_share_settings share ON share.problem_id = p.id
    WHERE ${selector} AND b.domain_id = ${domainId}
      AND (${member} OR b.visibility = 'public') AND ${bindingAvailabilityCondition()})`;
}

/** 批量教学读取需要的绑定事实，不包含题面、答案、文件或 Provider 配置。 */
export interface BindingAvailability {
  id: string;
  problem_id: string;
  effective_version_mode: "any" | "exact";
  required_version_id: string | null;
  answer_version_id: string | null;
  revision: number;
  available: boolean;
  policy_actor_id: string | null;
  version_actor_id: string | null;
}

/** 当前数据库授权是唯一依据；索引或缓存未同步不能放行被撤销的引用。 */
export async function loadBindingAvailability(
  executor: Executor,
  domainId: string,
  bindingIds: string[],
) {
  if (!bindingIds.length) return [];
  const rows = await executor.execute(
    sql`SELECT b.id, b.problem_id, b.effective_version_mode,
    b.required_version_id, b.revision,
    (SELECT h.actor_id FROM problem_binding_history h WHERE h.binding_id = b.id AND h.revision = b.revision) AS policy_actor_id,
    (SELECT v.published_by FROM problem_versions v WHERE v.id = CASE WHEN b.effective_version_mode = 'exact'
      THEN b.required_version_id ELSE p.latest_version_id END) AS version_actor_id,
    CASE WHEN b.effective_version_mode = 'exact' THEN b.required_version_id ELSE p.latest_version_id END AS answer_version_id,
    (${bindingAvailabilityCondition()}) AS available
    FROM domain_problem_bindings b JOIN problems p ON p.id = b.problem_id
    JOIN domains src ON src.id = p.domain_id
    LEFT JOIN problem_share_settings share ON share.problem_id = p.id
    WHERE b.domain_id = ${domainId} AND b.id IN (${
      sql.join(bindingIds.map((id) => sql`${id}`), sql`, `)
    })`,
  );
  return unwrapRows<BindingAvailability>(rows as never);
}
