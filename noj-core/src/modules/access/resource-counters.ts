/**
 * 域资源计数器的窄事务能力。
 *
 * `domain_resource_counters` 由 access 持有，问题/资产等业务只能在自己的
 * application 外层事务中调用这些必填 `DbTx` 函数，不能直接更新共享表。
 */
import { and, eq, sql } from "drizzle-orm";
import type { DbTx } from "../../shared/db/executor.ts";
import { domainResourceCounters } from "../../shared/db/schema.ts";

export type DomainResourceName = "members" | "problems" | "storage_bytes";

export async function setDomainResourceCounterTx(
  tx: DbTx,
  domainId: string,
  resource: DomainResourceName,
  used: number,
): Promise<void> {
  if (!Number.isSafeInteger(used) || used < 0) {
    throw new RangeError("域资源计数必须是非负安全整数");
  }
  await tx.insert(domainResourceCounters).values({
    domain_id: domainId,
    resource,
    used,
  }).onConflictDoUpdate({
    target: [domainResourceCounters.domain_id, domainResourceCounters.resource],
    set: { used },
  });
}

export async function adjustDomainResourceCounterTx(
  tx: DbTx,
  domainId: string,
  resource: DomainResourceName,
  delta: number,
): Promise<void> {
  if (!Number.isSafeInteger(delta)) {
    throw new RangeError("域资源计数增量必须是安全整数");
  }
  await tx.update(domainResourceCounters).set({
    used: sql`${domainResourceCounters.used} + ${delta}`,
  }).where(and(
    eq(domainResourceCounters.domain_id, domainId),
    eq(domainResourceCounters.resource, resource),
  ));
}
