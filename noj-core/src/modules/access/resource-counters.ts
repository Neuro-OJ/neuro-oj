/**
 * 域资源计数器的窄事务能力。
 *
 * `domain_resource_counters` 由 access 持有，问题/资产等业务只能在自己的
 * application 外层事务中调用这些必填 `DbTx` 函数，不能直接更新共享表。
 *
 * 所有函数都：
 * - 第一个参数是真实 `DbTx`，不自开根事务、不读默认连接；
 * - 只写 access 拥有的计数表；
 * - 校验安全整数与非负不变量，缺行时不静默更新 0 行。
 */
import { and, eq, sql } from "drizzle-orm";
import type { DbTx } from "../../shared/db/executor.ts";
import { domainResourceCounters } from "../../shared/db/schema.ts";

export type DomainResourceName = "members" | "problems" | "storage_bytes";

/** 计数行快照；`used` 与 `reserved` 都是持久事实，不含进程内状态。 */
export interface DomainResourceCounterSnapshot {
  readonly used: number;
  readonly reserved: number;
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label}必须是非负安全整数`);
  }
}

/**
 * 初始化并锁定唯一计数行，返回锁定后的 used/reserved。
 *
 * 缺行会先插入 0 行再锁定，因此调用方拿到的总是**存在且已加锁**的行；
 * 后续结算与预约判断都在同一把行锁内完成。
 */
export async function lockDomainResourceCounterTx(
  tx: DbTx,
  domainId: string,
  resource: DomainResourceName,
): Promise<DomainResourceCounterSnapshot> {
  await tx.insert(domainResourceCounters).values({
    domain_id: domainId,
    resource,
  }).onConflictDoNothing();
  const [counter] = await tx.select({
    used: domainResourceCounters.used,
    reserved: domainResourceCounters.reserved,
  }).from(domainResourceCounters).where(and(
    eq(domainResourceCounters.domain_id, domainId),
    eq(domainResourceCounters.resource, resource),
  )).for("update");
  if (!counter) {
    // 刚插入并锁定过的行不可能不存在；出现即说明并发删除，必须显式失败。
    throw new Error(`域资源计数行缺失：${domainId}/${resource}`);
  }
  assertNonNegativeSafeInteger(counter.used, "域资源已用量");
  assertNonNegativeSafeInteger(counter.reserved, "域资源预占量");
  return { used: counter.used, reserved: counter.reserved };
}

/** 直接设定 used；reserved 保持不动。 */
export async function setDomainResourceCounterTx(
  tx: DbTx,
  domainId: string,
  resource: DomainResourceName,
  used: number,
): Promise<void> {
  assertNonNegativeSafeInteger(used, "域资源计数");
  await tx.insert(domainResourceCounters).values({
    domain_id: domainId,
    resource,
    used,
  }).onConflictDoUpdate({
    target: [domainResourceCounters.domain_id, domainResourceCounters.resource],
    set: { used },
  });
}

/**
 * 按增量调整 used。
 *
 * 用 SQL 表达式原子累加，并在同一条语句上校验结果非负：并发调整不会互相覆盖，
 * 也不允许把计数减成负数。
 */
export async function adjustDomainResourceCounterTx(
  tx: DbTx,
  domainId: string,
  resource: DomainResourceName,
  delta: number,
): Promise<void> {
  if (!Number.isSafeInteger(delta)) {
    throw new RangeError("域资源计数增量必须是安全整数");
  }
  const updated = await tx.update(domainResourceCounters).set({
    used: sql`${domainResourceCounters.used} + ${delta}`,
  }).where(and(
    eq(domainResourceCounters.domain_id, domainId),
    eq(domainResourceCounters.resource, resource),
  )).returning({ used: domainResourceCounters.used });
  if (!updated.length) {
    throw new Error(`域资源计数行缺失：${domainId}/${resource}`);
  }
  assertNonNegativeSafeInteger(updated[0].used, "域资源已用量");
}

/**
 * 设定预占量；调用方必须已经用 `lockDomainResourceCounterTx` 取得行锁。
 */
export async function setDomainResourceReservedTx(
  tx: DbTx,
  domainId: string,
  resource: DomainResourceName,
  reserved: number,
): Promise<void> {
  assertNonNegativeSafeInteger(reserved, "域资源预占量");
  const updated = await tx.update(domainResourceCounters).set({ reserved })
    .where(and(
      eq(domainResourceCounters.domain_id, domainId),
      eq(domainResourceCounters.resource, resource),
    )).returning({ reserved: domainResourceCounters.reserved });
  if (!updated.length) {
    throw new Error(`域资源计数行缺失：${domainId}/${resource}`);
  }
}
