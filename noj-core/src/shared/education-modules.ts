import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "./db/executor.ts";
import { domains, educationDisabledIntervals } from "./db/schema.ts";
import {
  allowedDomainFeatures,
  validateWorkspaceSetting,
} from "./workspace/resource-policy.ts";
import { recordEducationEvent } from "./education-events.ts";

/** 设置写入事务持有设置行锁；全实例停用区间覆盖随后创建的 Domain。 */
export async function recordInstanceEducationModulesChange(
  executor: Executor,
  previousRaw: string | null | undefined,
  nextRaw: string,
  now: string,
) {
  const previous = previousRaw == null
    ? allowedDomainFeatures()
    : validateWorkspaceSetting(
      "domain_features",
      JSON.parse(previousRaw) as string,
    ) as ReturnType<typeof allowedDomainFeatures>;
  const next = validateWorkspaceSetting(
    "domain_features",
    JSON.parse(nextRaw) as string,
  ) as ReturnType<typeof allowedDomainFeatures>;
  let changed = false;
  for (const feature of ["classroom", "assignment"] as const) {
    if (previous[feature] === next[feature]) continue;
    changed = true;
    const reason = `instance.${feature}`;
    if (!next[feature]) {
      await executor.insert(educationDisabledIntervals).values({
        id: crypto.randomUUID(),
        domain_id: null,
        started_at: now,
        reason,
      });
    } else {await executor.update(educationDisabledIntervals).set({
        ended_at: now,
      }).where(and(
        isNull(educationDisabledIntervals.domain_id),
        eq(educationDisabledIntervals.reason, reason),
        isNull(educationDisabledIntervals.ended_at),
      ));}
  }
  if (!changed) return;
  const rows = await executor.select({ id: domains.id }).from(domains).orderBy(
    domains.id,
  );
  for (const domain of rows) {
    await recordEducationEvent(executor, {
      domain_id: domain.id,
      event_type: "module.changed",
    });
  }
}
