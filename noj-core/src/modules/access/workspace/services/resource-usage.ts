import { eq } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { domainResourceCounters } from "../../../../shared/db/schema.ts";
import { getDomainStorageUsage } from "../../../assets/index.ts";

/** 授权配额页面读取实际占用与预约，不把每分钟提交频率当容量计数。 */
export async function getDomainResourceUsage(domainId: string) {
  const rows = await getDb().select().from(domainResourceCounters).where(
    eq(domainResourceCounters.domain_id, domainId),
  );
  const members = rows.find((row) => row.resource === "members");
  const problems = rows.find((row) => row.resource === "problems");
  if (!members || !problems) {
    throw new AppError(
      "工作空间容量计数未初始化",
      500,
      "DOMAIN_RESOURCE_COUNTER_MISSING",
    );
  }
  const storage = await getDomainStorageUsage(domainId);
  return {
    members: members.used,
    problems: problems.used,
    storage_bytes: storage.used,
    reserved_members: members.reserved,
    reserved_problems: problems.reserved,
    reserved_storage_bytes: storage.reserved,
  };
}
