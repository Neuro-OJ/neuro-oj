import { getRedis } from "../../../../shared/mq/connection.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import { getDomainEffectiveLimits } from "./limits.ts";

/** Redis 时间桶及受理标记一起写入，多副本共享域总频率。 */
export const DOMAIN_SUBMISSION_QUOTA_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 1 end
local now = redis.call('TIME')
local minute = math.floor(tonumber(now[1]) / 60)
local bucket = KEYS[1] .. ':' .. minute
local count = tonumber(redis.call('GET', bucket) or '0')
if count >= tonumber(ARGV[1]) then return 0 end
redis.call('INCR', bucket)
redis.call('EXPIRE', bucket, 120)
redis.call('SET', KEYS[2], '1', 'EX', 86400)
return 1
`.trim();

/** 资源授权后、首次执行前调用；operationKey 为服务器提交/尝试/任务条目 ID。 */
export async function consumeDomainSubmissionQuota(
  domainId: string,
  actorId: string,
  operationKey: string,
  executor?: Executor,
): Promise<void> {
  const { effective } = await getDomainEffectiveLimits(domainId, executor);
  if (effective.submissions_per_minute === null) return;
  let allowed: number;
  try {
    const redis = getRedis();
    if (redis.status !== "ready") {
      throw new Error("Redis 尚未就绪");
    }
    allowed = await redis.eval(
      DOMAIN_SUBMISSION_QUOTA_SCRIPT,
      2,
      `noj:domain:{${domainId}}:submission-minute`,
      `noj:domain:{${domainId}}:submission-operation:${actorId}:${operationKey}`,
      effective.submissions_per_minute,
    );
  } catch {
    throw new AppError(
      "域提交限额服务暂时不可用",
      503,
      "DOMAIN_SUBMISSION_QUOTA_UNAVAILABLE",
    );
  }
  if (allowed !== 1) {
    throw new AppError(
      "域提交频率已达上限，请稍后再试",
      429,
      "DOMAIN_SUBMISSION_QUOTA_EXCEEDED",
    );
  }
}
