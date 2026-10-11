/**
 * 升级副本占用**原用户正常提交额度**（Handbook §4.4；2026-10-11 复审问题 9）。
 *
 * 背景：升级任务受理侧只限制了"每分钟 3 个任务 × 500 条"的任务级额度，
 * worker 为每条条目创建新提交时**不消耗原用户的正常提交预算**（普通提交为
 * 每用户 60s/120 次）。于是一个用户可以借批量升级把自己的提交次数放大 500 倍
 * （管理员代升级同理）。本模块提供逐副本、按原用户计费、可幂等重派的额度入口。
 *
 * 设计要点：
 * - **共享窗口**：与普通提交使用同一 Redis 键（`submission:user:<原用户>`），
 *   因此升级副本与正常提交互相占用同一份预算；
 * - **幂等**：以 `submission_job_items.id`（`jobItemId`）为幂等标识。同一副本
 *   在 24h 内重复派发只扣一次；首次扣费前先原子占位（SET NX），额度不足时释放
 *   占位并返回延期信号，稍后重试仍可正常扣费；
 * - **不抛异常**：额度不足用返回值表达（`{ ok: false, retryAfterMs }`），调用方
 *   （task-9 的派发事务）据此回滚并 `requeueJobItem` 延期，而不是把条目判失败；
 * - **原用户预算**：管理员代升级时调用方必须传**原用户** id，本函数只认传入的
 *   `sourceUserId`，与 actor 无关；
 * - 不限流环境（`NOJ_ENV=test` 且未显式开启 `RATE_LIMIT_ENABLED`）直接放行，
 *   保持既有测试/开发语义。
 */
import { getRedis } from "../../../../shared/mq/connection.ts";
import type { RateLimitConfig } from "../../../../shared/rate-limit/rate-limit.ts";
import { getLogger } from "@logtape/logtape";
import {
  isRateLimitEnabled,
  SUBMISSION_USER_LIMIT,
  tryConsumeRateLimit,
} from "../../../system/index.ts";

const logger = getLogger(["noj", "submission"]);

/** 与普通提交共享的额度键前缀（必须与 `enforceSubmissionRateLimit` 一致）。 */
const SUBMISSION_USER_KEY_PREFIX = "submission:user:";

/**
 * 幂等占位前缀。标记存在 = 该副本已经占用过一次额度。
 *
 * TTL 取得比限流窗口长得多：窗口内重试、派发失败重投、sweeper 恢复都可能重复
 * 调用同一副本，这些都不应重复扣费。
 */
const UPGRADE_QUOTA_MARKER_PREFIX = "hardening:upgrade-quota:item:";
const UPGRADE_QUOTA_MARKER_TTL_MS = 24 * 60 * 60 * 1000;

/** 幂等占位键（job item 维度）。 */
function markerKey(sourceUserId: string, jobItemId: string): string {
  return `${UPGRADE_QUOTA_MARKER_PREFIX}${sourceUserId}:${jobItemId}`;
}

/** 额度占用结果：`ok=false` 表示应延期重试，而不是失败。 */
export type UpgradeQuotaConsumption =
  | { ok: true }
  | { ok: false; retryAfterMs: number };

/**
 * 为**一个升级副本**占用原用户的正常提交额度（幂等）。
 *
 * 调用时机：派发升级条目、创建新提交的同一事务内。额度不足时本函数**不抛错**，
 * 调用方应回滚事务并把条目延期（`retryAfterMs` 作为下次派发时间），条目保持
 * 可重试、不计失败、不产生新提交。
 *
 * 幂等语义：首次调用成功时写入 24h 占位标记；同一条目再次调用（无论事务是否已
 * 回滚）直接返回 `{ ok: true }` 且**不重复扣费**。占位在额度不足时会立即释放，
 * 因此被延期后的重试仍能正常扣费。
 *
 * @param sourceUserId 原提交所属用户（管理员代升级时也是原用户，不是 actor）
 * @param jobItemId 幂等标识：`submission_job_items.id`
 * @param options.limit 覆盖额度配置（默认与普通提交一致：60s/120 次）
 * @returns 扣费成功，或结构化延期信号
 */
export async function consumeSubmissionQuotaForUpgrade(
  sourceUserId: string,
  jobItemId: string,
  options: { limit?: RateLimitConfig } = {},
): Promise<UpgradeQuotaConsumption> {
  // 总开关优先：升级额度**就是**普通提交额度，限流总开关关闭时（含 `NOJ_ENV=test`
  // 默认关闭）必须与 `enforceSubmissionRateLimit`/`tryConsumeRateLimit` 一样直接放行，
  // 不能先去碰 Redis 占位——否则 Redis 不可用会把"未启用限流"误判成"额度不可用"，
  // 使正常升级被延期（2026-10-11 集成验收在整目录运行时命中）。
  if (!isRateLimitEnabled()) return { ok: true };

  const limit = options.limit ?? SUBMISSION_USER_LIMIT;
  let marker: string;
  try {
    const redis = getRedis();
    marker = markerKey(sourceUserId, jobItemId);
    // 先原子占位：只有一个调用者能拿到这次扣费资格（多副本安全）。
    // 用 Lua 保证 SET NX + PX 原子（共享 `RedisClient` 门面没有 PX+NX 组合签名）。
    const claimed = await redis.eval(
      "if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 1 else return 0 end",
      1,
      marker,
      new Date().toISOString(),
      UPGRADE_QUOTA_MARKER_TTL_MS,
    );
    if (claimed !== 1) {
      // 同一副本已扣过费（重派/重投/sweeper 恢复）→ 幂等放行，不重复占用额度
      return { ok: true };
    }
  } catch (err) {
    // Redis 不可用：fail-closed 延期（不产生无额度约束的副本）
    logger.warn("升级额度占位失败，按延期处理", { err, jobItemId });
    return { ok: false, retryAfterMs: Math.max(1000, limit.windowSec * 1000) };
  }

  const consumed = await tryConsumeRateLimit(
    `${SUBMISSION_USER_KEY_PREFIX}${sourceUserId}`,
    limit,
  );
  if (consumed.allowed) return { ok: true };

  // 额度不足：释放占位，让窗口滚动后的重试重新扣费
  try {
    await getRedis().del(marker);
  } catch {
    // 占位会在 24h 后自然过期；失败不改变"本次未扣费"的结论
  }
  // 兜底：限流实现可能不返回 retryAfterMs（或返回非有限值）。若把 NaN/undefined
  // 传下去，调用方的 `plusSeconds(Math.ceil(NaN/1000))` 会抛 RangeError，
  // 把"延期"变成真正的失败（2026-10-11 集成验收发现）。
  const retryAfterMs = Number.isFinite(consumed.retryAfterMs) &&
      (consumed.retryAfterMs as number) > 0
    ? consumed.retryAfterMs as number
    : Math.max(1000, limit.windowSec * 1000);
  return { ok: false, retryAfterMs };
}
