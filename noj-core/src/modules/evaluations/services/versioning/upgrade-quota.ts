/**
 * 升级副本占用**原用户正常提交额度**（Handbook §4.4；2026-10-11 复审问题 9/5）。
 *
 * 背景：升级任务受理侧只限制了"每分钟 3 个任务 × 500 条"的任务级额度，
 * worker 为每条条目创建新提交时**不消耗原用户的正常提交预算**（普通提交为
 * 每用户 60s/120 次）。于是一个用户可以借批量升级把自己的提交次数放大 500 倍
 * （管理员代升级同理）。本模块提供逐副本、按原用户计费、可幂等重派的额度入口。
 *
 * 设计要点：
 * - **共享窗口**：与**对应题型**的正常提交使用同一 Redis 键（代码 `submission:user:`、
 *   竞赛代码 `contest-submission:user:`、客观题 `objective-submit:user:`），
 *   因此升级副本与正常提交互相占用同一份预算（2026-10-11 复审问题 6：必须按新副本
 *   的题型选桶，否则用户可以用另一种题型的额度绕过限制）；
 * - **幂等**：以 `submission_job_items.id`（`jobItemId`）为幂等标识，标记 TTL 24h：
 *   同一副本重复派发只扣一次；
 * - **占位与扣费原子**（2026-10-11 复审问题 5）：幂等标记检查、额度计数、成功标记
 *   写入在**同一个 Lua 脚本**内完成。标记只代表"扣费已完成"，脚本在额度不足或
 *   扣费失败时**不写任何标记**；因此不存在"标记已写、额度未扣"的窗口
 *   （旧实现先占位、再扣费：占位成功而扣费与清理占位都失败时会无限放行）；
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
  SUBMISSION_QUOTA_BUCKETS,
  type SubmissionQuotaBucket,
  submissionQuotaRedisKey,
} from "../../../../domains/system/index.ts";

const logger = getLogger(["noj", "submission"]);

/**
 * 升级副本占用的额度桶（与三类正常提交一一对应，2026-10-11 复审问题 6）。
 *
 * - `code`：普通代码提交（键 `submission:user:<id>`）
 * - `contest_code`：竞赛内代码提交（键 `contest-submission:user:<id>`）
 * - `objective`：客观题提交（键 `objective-submit:user:<id>`）
 *
 * 桶选择必须与"新副本实际生成的提交类型"一致，否则用户可以用另一种题型的额度
 * 绕过限制（例如用练习额度跑竞赛升级）。
 */
export type UpgradeQuotaBucket = SubmissionQuotaBucket;

/** {@link consumeSubmissionQuotaForUpgrade} 的选项。 */
export interface UpgradeQuotaOptions {
  /** 覆盖额度配置（默认按桶选择，测试用小额度注入）。 */
  limit?: RateLimitConfig;
  /** 额度桶，缺省 `code`（普通代码提交）。 */
  bucket?: UpgradeQuotaBucket;
  /** 竞赛上下文：**仅用于日志/审计**，额度键仍按原用户维度（不按竞赛拆分）。 */
  contestId?: string | null;
}

/**
 * 幂等标记前缀。标记存在 = 该副本**已经完成扣费**（不是"准备扣费"）。
 *
 * TTL 取得比限流窗口长得多：窗口内重试、派发失败重投、sweeper 恢复都可能重复
 * 调用同一副本，这些都不应重复扣费。
 */
const UPGRADE_QUOTA_MARKER_PREFIX = "hardening:upgrade-quota:item:";
const UPGRADE_QUOTA_MARKER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 幂等标记键（job item 维度）。
 *
 * @param sourceUserId 原提交所属用户
 * @param jobItemId `submission_job_items.id`
 * @returns 幂等标记的完整 Redis 键
 */
export function upgradeQuotaMarkerKey(
  sourceUserId: string,
  jobItemId: string,
): string {
  return `${UPGRADE_QUOTA_MARKER_PREFIX}${sourceUserId}:${jobItemId}`;
}

/**
 * 原子额度占用脚本（单次 EVAL，Redis 侧原子执行）。
 *
 * 顺序严格为「检查幂等 → 扣费 → 写标记」，且**只有扣费成功才写标记**：
 *
 * - `KEYS[1]` 幂等标记；`KEYS[2]` 普通提交额度计数键（与 `enforceSubmissionRateLimit`
 *   同键/窗口/TTL，经 `submissionUserQuotaRedisKey` 构造）；
 * - `ARGV[1]` 标记值（ISO 时刻）；`ARGV[2]` 标记 TTL(ms)；`ARGV[3]` 窗口(ms)；
 *   `ARGV[4]` 窗口上限；
 * - 返回 `{ok, ttlMs}`：`ok=1` 已占用额度（或本副本此前已占用）；`ok=0` 额度不足，
 *   此时**没有写入任何标记**，`ttlMs` 为窗口剩余毫秒（供延期）。
 *
 * 计数语义与 `checkRateLimit` 完全一致：`INCR` 后首次（或 TTL 缺失）设置 `PEXPIRE`；
 * 被拒绝的尝试同样计数，窗口滚动即复位。
 *
 * 导出该脚本供测试直接执行（模拟"请求已执行但响应丢失"）。
 */
export const UPGRADE_QUOTA_CONSUME_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return {1, 0}
end
local count = redis.call('INCR', KEYS[2])
local ttl = redis.call('PTTL', KEYS[2])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[2], ARGV[3])
  ttl = tonumber(ARGV[3])
end
if count > tonumber(ARGV[4]) then
  return {0, ttl}
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return {1, 0}
`.trim();

/** 额度占用结果：`ok=false` 表示应延期重试，而不是失败。 */
export type UpgradeQuotaConsumption =
  | { ok: true }
  | { ok: false; retryAfterMs: number };

/**
 * 为**一个升级副本**占用原用户的正常提交额度（幂等 + 原子）。
 *
 * 调用时机：派发升级条目、创建新提交的同一事务内。额度不足时本函数**不抛错**，
 * 调用方应回滚事务并把条目延期（`retryAfterMs` 作为下次派发时间），条目保持
 * 可重试、不计失败、不产生新提交。
 *
 * 幂等语义：扣费成功即在同一次 EVAL 内写入 24h 标记；同一条目再次调用（无论事务
 * 是否已回滚、响应是否丢失、连接是否重建）直接返回 `{ ok: true }` 且**不重复扣费**。
 * 额度不足或扣费失败时脚本不写标记，因此延期后的重试仍会正常扣费。
 *
 * @param sourceUserId 原提交所属用户（管理员代升级时也是原用户，不是 actor）
 * @param jobItemId 幂等标识：`submission_job_items.id`
 * @param options.limit 覆盖额度配置（默认按 `options.bucket` 选择）
 * @param options.bucket 额度桶：`code`（缺省）/ `contest_code` / `objective`
 * @param options.contestId 竞赛上下文，仅用于日志审计
 * @returns 扣费成功，或结构化延期信号
 */
export async function consumeSubmissionQuotaForUpgrade(
  sourceUserId: string,
  jobItemId: string,
  options: UpgradeQuotaOptions = {},
): Promise<UpgradeQuotaConsumption> {
  // 总开关优先：升级额度**就是**对应桶的正常提交额度，限流总开关关闭时
  // （含 `NOJ_ENV=test` 默认关闭）必须与 `enforce*` 系列一样直接放行，不能先去碰
  // Redis——否则 Redis 不可用会把"未启用限流"误判成"额度不可用"，使正常升级被延期
  // （2026-10-11 集成验收在整目录运行时命中）。
  if (!isRateLimitEnabled()) return { ok: true };

  const bucket = options.bucket ?? "code";
  const limit = options.limit ?? SUBMISSION_QUOTA_BUCKETS[bucket].limit;
  // 兜底等待时长：即使限流返回值异常也不能把 NaN/undefined 传给调用方
  // （`plusSeconds(Math.ceil(NaN/1000))` 会抛 RangeError，把"延期"变成真正的失败）
  const fallbackRetryAfterMs = Math.max(1000, limit.windowSec * 1000);
  try {
    const redis = getRedis();
    const raw = await redis.eval(
      UPGRADE_QUOTA_CONSUME_SCRIPT,
      2,
      upgradeQuotaMarkerKey(sourceUserId, jobItemId),
      // 与对应桶的正常提交**同键**：`code` / `contest_code` / `objective`
      submissionQuotaRedisKey(bucket, sourceUserId),
      new Date().toISOString(),
      UPGRADE_QUOTA_MARKER_TTL_MS,
      limit.windowSec * 1000,
      limit.max,
    );
    const result = Array.isArray(raw) ? raw as number[] : [0, 0];
    if (Number(result[0]) === 1) return { ok: true };
    const ttl = Number(result[1]);
    return {
      ok: false,
      retryAfterMs: Number.isFinite(ttl) && ttl > 0
        ? ttl
        : fallbackRetryAfterMs,
    };
  } catch (err) {
    // Redis 不可用 / 脚本执行失败：fail-closed 延期。
    // 脚本的写操作只发生在扣费成功之后，失败时不会留下"已标记但未扣费"的状态。
    logger.warn("升级额度占用失败，按延期处理", {
      err,
      jobItemId,
      bucket,
      contestId: options.contestId ?? null,
    });
    return { ok: false, retryAfterMs: fallbackRetryAfterMs };
  }
}
