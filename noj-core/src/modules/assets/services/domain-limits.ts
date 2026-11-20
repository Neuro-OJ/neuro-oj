/**
 * assets 只读取域配额中的存储维度。
 *
 * `domain_limits` 的写入仍由 access 负责；资产容量保护只在同一个 DbTx 中
 * 重读当前域行和 platform 的实例上限，避免使用跨请求缓存或访问旧 workspace
 * 写服务。这样删除/预约与权限政策变化共享同一数据库事实。
 */
import { eq } from "drizzle-orm";
import { AppError } from "../../../shared/base/errors.ts";
import type { DbRoot, DbTx } from "../../../shared/db/executor.ts";
import { domainLimits } from "../../../shared/db/schema.ts";
import { getInstanceResourcePolicy } from "../../platform/contracts/resource-policy.ts";

type LimitsDb = Pick<DbRoot, "select">;

function effectiveStorageLimit(
  configured: number | null,
  cap: number | null,
): number | null {
  if (configured === null) return cap;
  if (cap === null) return configured;
  return Math.min(configured, cap);
}

/** 读取当前域存储容量及实例 cap；调用方可传入真实 DbTx。 */
export async function getDomainEffectiveLimits(
  domainId: string,
  db: LimitsDb,
) {
  const [stored] = await db.select().from(domainLimits).where(
    eq(domainLimits.domain_id, domainId),
  );
  if (!stored) {
    throw new AppError("工作空间配额未初始化", 500, "DOMAIN_LIMITS_MISSING");
  }
  const policy = await getInstanceResourcePolicy(db);
  const storageBytes = effectiveStorageLimit(
    stored.storage_bytes,
    policy.limit_caps.storage_bytes,
  );
  return {
    configured: { storage_bytes: stored.storage_bytes },
    effective: { storage_bytes: storageBytes },
    caps: { storage_bytes: policy.limit_caps.storage_bytes },
  };
}

/** 语义别名，便于原子 helper 显式表达它需要事务。 */
export function getDomainEffectiveLimitsTx(domainId: string, tx: DbTx) {
  return getDomainEffectiveLimits(domainId, tx);
}
