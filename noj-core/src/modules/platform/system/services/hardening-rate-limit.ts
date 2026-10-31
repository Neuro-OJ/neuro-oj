/**
 * 审计修复（NOJ-093/094/096/069）使用的高风险端点限流。
 *
 * 与登录限流一样走 Redis 固定窗口。Redis 不可用时默认 fail-closed（503）；
 * 低风险写入（社区互动、教学写操作、创建题目）可显式选择放行，见
 * {@link RateLimitUnavailablePolicy}。
 * 阈值故意保持宽松以兼容现有 API 客户端，同时阻止无差别批量刷接口。
 */

import { getLogger } from "@logtape/logtape";
import {
  RateLimitedError,
  ServiceUnavailableError,
} from "../../../../shared/base/errors.ts";
import {
  checkRateLimit,
  type RateLimitConfig,
  rateLimitHeaders,
} from "../../../../shared/rate-limit/rate-limit.ts";
import { getClientIp, isRateLimitEnabled } from "./rate-limit-env.ts";
import type { Context } from "hono";

const logger = getLogger(["noj", "system"]);

/**
 * 机房场景下同一出口 IP 背后的并发考生数估计。
 *
 * 学校机房通常整间共用一个 NAT 出口。提交类接口的 IP 维度只用于拦截明显的
 * 脚本刷量，阈值按「用户阈值 × 席位数」计算；真正的单人上限由用户维度负责。
 * 此前 IP 阈值与用户阈值相同，60 人集中交卷时会被 IP 维度误伤（#698 P0-1）。
 */
export const SHARED_IP_SEATS = 60;

export const REGISTER_LIMIT: RateLimitConfig = {
  windowSec: 3600,
  max: 100,
};

export const PASSWORD_RESET_IP_LIMIT: RateLimitConfig = {
  windowSec: 3600,
  max: 30,
};

export const PASSWORD_RESET_EMAIL_LIMIT: RateLimitConfig = {
  windowSec: 3600,
  max: 10,
};

export const EMAIL_VERIFICATION_RESEND_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 1,
};

export const MESSAGE_SEND_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 60,
};

export const SUBMISSION_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

export const SUBMISSION_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: SUBMISSION_USER_LIMIT.max * SHARED_IP_SEATS,
};

export const SELF_TEST_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 4,
};

export const SELF_TEST_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: SELF_TEST_USER_LIMIT.max * SHARED_IP_SEATS,
};

export const CONTEST_SUBMISSION_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

export const CONTEST_SUBMISSION_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: CONTEST_SUBMISSION_USER_LIMIT.max * SHARED_IP_SEATS,
};

/**
 * 升级任务受理：一次受理最多 500 条提交，因此比普通提交更严格
 * （Handbook §4.4：升级仍执行正常提交速率限制）。
 */
export const UPGRADE_JOB_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 10,
};

export const UPGRADE_JOB_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 3,
};

export const OBJECTIVE_SUBMIT_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 60,
};

export const OBJECTIVE_SUBMIT_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: OBJECTIVE_SUBMIT_USER_LIMIT.max * SHARED_IP_SEATS,
};

export const PROBLEM_CREATE_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 30,
};

export const PROBLEM_CREATE_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 30,
};

export const PROBLEM_IMPORT_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 10,
};

export const PROBLEM_IMPORT_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 10,
};

export const POST_LIKE_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

export const POST_LIKE_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

export const COMMENT_LIKE_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

export const COMMENT_LIKE_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

export const BOOKMARK_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

export const BOOKMARK_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

export const FOLLOW_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

export const FOLLOW_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

export const REPORT_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 30,
};

export const REPORT_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 30,
};

/**
 * 每日签到：按账号的写窗口。
 *
 * 签到本身按 (user_id, 日期) 幂等，重复调用不会重复计分，但它仍是**写**端点：
 * 无窗口时脚本可以无限次打 DB 事务。窗口取得比交互频率宽（60s/10），正常用户
 * 一天点一次不会触发，连续重试也不会被误伤。
 */
export const CHECKIN_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 10,
};

/**
 * 邮件投递回执：按来源 IP 的写窗口。
 *
 * 该端点对公网开放（厂商回调），签名与 `email_webhook_secret` 校验才是第一道门；
 * 限流挡的是伪造/重放的高频请求在签名校验前后白白消耗 DB 与连接。厂商可能批量
 * 追送回执，因此窗口放到 60s/120，远高于单次回调频率。
 */
export const EMAIL_DELIVERY_EVENT_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

function normalizeLimitKey(value: string): string {
  return value.trim().toLowerCase().slice(0, 128);
}

/**
 * `shared/rate-limit/rate-limit.ts` 的内部 Redis 键前缀（该模块未导出）。
 *
 * 需要**复用同一计数键**的场景（升级副本额度脚本、故障注入测试）必须与本模块的
 * `enforceRateLimit` 落到完全相同的键上，否则会出现"两套额度"。
 */
const SHARED_RATE_LIMIT_KEY_PREFIX = "ratelimit";

/**
 * 正常提交的额度桶。三类提交各自独立计数（键前缀与阈值必须与对应 `enforce*` 一致）：
 *
 * | bucket | 正常提交入口 | 键前缀 | 阈值常量 |
 * |---|---|---|---|
 * | `code` | `enforceSubmissionRateLimit` | `submission:user:` | {@link SUBMISSION_USER_LIMIT} |
 * | `contest_code` | `enforceContestSubmissionRateLimit` | `contest-submission:user:` | {@link CONTEST_SUBMISSION_USER_LIMIT} |
 * | `objective` | `enforceObjectiveSubmitRateLimit` | `objective-submit:user:` | {@link OBJECTIVE_SUBMIT_USER_LIMIT} |
 */
export type SubmissionQuotaBucket = "code" | "contest_code" | "objective";

/**
 * 额度桶 → 正常提交的键前缀与窗口配置（单一事实源）。
 *
 * 升级副本必须"占用与它等价的正常提交额度"：代码升级扣代码桶、竞赛内升级扣
 * 竞赛提交桶、客观题升级扣客观题桶，否则用户可以用另一种题型的额度绕过限制
 * （2026-10-11 复审问题 6）。
 */
export const SUBMISSION_QUOTA_BUCKETS: Record<
  SubmissionQuotaBucket,
  { keyPrefix: string; limit: RateLimitConfig }
> = {
  code: { keyPrefix: "submission:user:", limit: SUBMISSION_USER_LIMIT },
  contest_code: {
    keyPrefix: "contest-submission:user:",
    limit: CONTEST_SUBMISSION_USER_LIMIT,
  },
  objective: {
    keyPrefix: "objective-submit:user:",
    limit: OBJECTIVE_SUBMIT_USER_LIMIT,
  },
};

/**
 * 指定额度桶的**用户额度 Redis 键**（与对应 `enforce*` 完全同键）。
 *
 * 归一化规则与 `enforceRateLimit` 逐字一致（`trim` + 小写 + 截断 128），因此
 * 升级副本额度脚本直接对同一键做 INCR/PEXPIRE 就等价于"占用该桶的正常提交额度"。
 *
 * @param bucket 额度桶（缺省调用方显式给出；`code` 为普通代码提交）
 * @param userId 提交用户（升级场景传**原用户**，不是操作者）
 * @returns 完整 Redis 键，例如 `ratelimit:hardening:submission:user:<uuid>`
 */
export function submissionQuotaRedisKey(
  bucket: SubmissionQuotaBucket,
  userId: string,
): string {
  const { keyPrefix } = SUBMISSION_QUOTA_BUCKETS[bucket];
  return `${SHARED_RATE_LIMIT_KEY_PREFIX}:hardening:${
    normalizeLimitKey(`${keyPrefix}${userId}`)
  }`;
}

/**
 * 普通**代码**提交的用户额度键（`submissionQuotaRedisKey("code", userId)` 的别名）。
 *
 * @param userId 提交用户
 * @returns 完整 Redis 键 `ratelimit:hardening:submission:user:<uuid>`
 */
export function submissionUserQuotaRedisKey(userId: string): string {
  return submissionQuotaRedisKey("code", userId);
}

/**
 * Redis 不可用时的处理策略。
 *
 * - `reject`（默认）：fail-closed，返回 503。用于认证、提交、导入等被绕过即有
 *   实际代价的入口。
 * - `allow`：放行并记录告警。用于点赞、收藏、教学写操作这类低风险写入，避免
 *   Redis 抖动时整站写入一起不可用（#698 P0-2）。
 */
export type RateLimitUnavailablePolicy = "reject" | "allow";

/**
 * 按固定窗口扣减一次额度，超限抛 {@link RateLimitedError}。
 *
 * @param key 未归一化的逻辑键
 * @param cfg 窗口配置
 * @param message 超限时的提示
 * @param onUnavailable Redis 不可用时的处理策略，默认 `reject`
 */
export async function enforceRateLimit(
  key: string,
  cfg: RateLimitConfig,
  message = "请求过于频繁，请稍后重试",
  onUnavailable: RateLimitUnavailablePolicy = "reject",
): Promise<void> {
  if (!isRateLimitEnabled()) return;
  await enforceRateLimitWith(checkRateLimit, key, cfg, message, onUnavailable);
}

/**
 * {@link enforceRateLimit} 的实现，计数函数可注入以便测试 Redis 故障分支。
 *
 * @internal 仅供本文件与测试使用，不经模块门面导出。
 */
export async function enforceRateLimitWith(
  check: typeof checkRateLimit,
  key: string,
  cfg: RateLimitConfig,
  message: string,
  onUnavailable: RateLimitUnavailablePolicy,
): Promise<void> {
  const normalized = `hardening:${normalizeLimitKey(key)}`;
  let result;
  try {
    result = await check(normalized, cfg);
  } catch (err) {
    if (onUnavailable === "allow" && err instanceof ServiceUnavailableError) {
      logger.warn("限流服务不可用，低风险写入按放行策略处理", {
        limit_key: normalized.split(":").slice(0, 3).join(":"),
      });
      return;
    }
    throw err;
  }
  if (!result.allowed) {
    throw new RateLimitedError(message, rateLimitHeaders(cfg, result));
  }
}

/** 教学写窗口按使用域和账号共享，允许正常批量教学操作。 */
export const EDUCATION_WRITE_LIMIT = { windowSec: 60, max: 120 } as const;

/** system 公开门面：教学写路由调用现有 Redis 固定窗口，不影响读取。 */
export async function enforceEducationWriteRateLimit(
  domainSlug: string,
  actorId: string,
): Promise<void> {
  await enforceRateLimit(
    `education-write:${domainSlug}:${actorId}`,
    EDUCATION_WRITE_LIMIT,
    "教学操作过于频繁，请稍后重试",
    "allow",
  );
}

/**
 * 非抛出的固定窗口计数检查（worker 侧「额度不足 → 延期」语义用）。
 *
 * 与 {@link enforceRateLimit} 共用**同一 key 归一化**与配置对象，因此传入相同
 * `submission:user:<id>` 键时会与普通提交共享同一个窗口计数器——这正是
 * 升级副本「占用原用户正常提交额度」的实现基础（2026-10-11 复审问题 9）。
 *
 * 语义差异（相对 `enforceRateLimit`）：
 * - 不抛 `RateLimitedError`，返回 `{ allowed, retryAfterMs }` 供调用方**延期重试**
 *   而不是把任务判失败；
 * - 限流总开关关闭（`NOJ_ENV=test` 默认）时直接放行，保持既有测试与开发语义；
 * - Redis 不可用时 **fail-closed**：按"额度不足"返回一个窗口长度的延时候选，
 *   让调用方稍后重试，绝不因为限流服务抖动而放行无限额度。
 *
 * @param key 未归一化的逻辑键（与 `enforceRateLimit` 传入值一致）
 * @param cfg 窗口配置（默认值由调用方决定）
 * @returns `allowed=false` 时 `retryAfterMs` 为距窗口重置的建议等待时长
 */
export async function tryConsumeRateLimit(
  key: string,
  cfg: RateLimitConfig,
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  if (!isRateLimitEnabled()) return { allowed: true, retryAfterMs: 0 };
  try {
    const result = await checkRateLimit(
      `hardening:${normalizeLimitKey(key)}`,
      cfg,
    );
    return {
      allowed: result.allowed,
      retryAfterMs: result.allowed
        ? 0
        : Math.max(1000, result.retryAfter * 1000),
    };
  } catch {
    // fail-closed：限流服务不可用时按额度不足处理（调用方延期重试）
    return {
      allowed: false,
      retryAfterMs: Math.max(1000, cfg.windowSec * 1000),
    };
  }
}

/** 注册端点：按客户端 IP 限流。 */
export async function enforceRegisterRateLimit(c: Context): Promise<void> {
  await enforceRateLimit(
    `register:ip:${getClientIp(c)}`,
    REGISTER_LIMIT,
    "注册过于频繁，请稍后重试",
  );
}

/** 竞赛注册：IP+竞赛维度限流（F-13）。 */
export async function enforceContestRegisterRateLimit(
  c: Context,
  contestId: string,
): Promise<void> {
  await enforceRateLimit(
    `contest-register:ip:${getClientIp(c)}:c:${contestId}`,
    { windowSec: 30, max: 5 },
    "注册过于频繁，请稍后重试",
  );
}

/** 忘记/重置密码：IP 维度。 */
export async function enforcePasswordResetIpRateLimit(
  c: Context,
): Promise<void> {
  await enforceRateLimit(
    `password-reset:ip:${getClientIp(c)}`,
    PASSWORD_RESET_IP_LIMIT,
  );
}

/** 忘记/重置密码：邮箱维度（防止对单个邮箱轰炸）。 */
export async function enforcePasswordResetEmailRateLimit(
  email: string,
): Promise<void> {
  await enforceRateLimit(
    `password-reset:email:${email}`,
    PASSWORD_RESET_EMAIL_LIMIT,
  );
}

/** 验证邮件重发：IP 与用户双维度，且无论账号状态都先计数以防枚举。 */
export async function enforceEmailVerificationResendRateLimit(
  c: Context,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `email-verification:ip:${getClientIp(c)}`,
    EMAIL_VERIFICATION_RESEND_LIMIT,
  );
  await enforceRateLimit(
    `email-verification:user:${userId}`,
    EMAIL_VERIFICATION_RESEND_LIMIT,
  );
}

/** 私信发送：按发送用户维度。 */
export async function enforceMessageSendRateLimit(
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `message:user:${userId}`,
    MESSAGE_SEND_LIMIT,
  );
}

/** 提交创建：IP + 用户双维度。 */
export async function enforceSubmissionRateLimit(
  c: Context,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `submission:ip:${getClientIp(c)}`,
    SUBMISSION_IP_LIMIT,
  );
  await enforceRateLimit(
    `submission:user:${userId}`,
    SUBMISSION_USER_LIMIT,
  );
}

/** 自测创建：IP + 用户双维度，阈值比正式提交更严格（默认每用户 60s 4 次）。 */
export async function enforceSelfTestRateLimit(
  c: Context,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `self-test:ip:${getClientIp(c)}`,
    SELF_TEST_IP_LIMIT,
  );
  await enforceRateLimit(
    `self-test:user:${userId}`,
    SELF_TEST_USER_LIMIT,
  );
}

/** 竞赛提交：IP + 用户双维度，与普通提交阈值一致但独立计数。 */
export async function enforceContestSubmissionRateLimit(
  c: Context,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `contest-submission:ip:${getClientIp(c)}`,
    CONTEST_SUBMISSION_IP_LIMIT,
  );
  await enforceRateLimit(
    `contest-submission:user:${userId}`,
    CONTEST_SUBMISSION_USER_LIMIT,
  );
}

/** 客观题提交：IP + 用户双维度。 */
export async function enforceObjectiveSubmitRateLimit(
  c: Context,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `objective-submit:ip:${getClientIp(c)}`,
    OBJECTIVE_SUBMIT_IP_LIMIT,
  );
  await enforceRateLimit(
    `objective-submit:user:${userId}`,
    OBJECTIVE_SUBMIT_USER_LIMIT,
  );
}

/**
 * 升级任务受理：IP + 用户双维度。
 *
 * 一次受理最多 500 条提交（Handbook §4.4），因此阈值比普通提交更严格：默认
 * 每用户 60s 3 次、每 IP 60s 10 次，防止「批量升级」被当作评测放大器滥用。
 */
export async function enforceUpgradeJobRateLimit(
  c: Context,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `upgrade-job:ip:${getClientIp(c)}`,
    UPGRADE_JOB_IP_LIMIT,
  );
  await enforceRateLimit(
    `upgrade-job:user:${userId}`,
    UPGRADE_JOB_USER_LIMIT,
  );
}

/** 题目创建：IP + 用户双维度。 */
export async function enforceProblemCreateRateLimit(
  c: Context,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `problem-create:ip:${getClientIp(c)}`,
    PROBLEM_CREATE_IP_LIMIT,
    undefined,
    "allow",
  );
  await enforceRateLimit(
    `problem-create:user:${userId}`,
    PROBLEM_CREATE_USER_LIMIT,
    undefined,
    "allow",
  );
}

/** 题目导入：IP + 用户双维度，阈值更严格（大包上传）。 */
export async function enforceProblemImportRateLimit(
  c: Context,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `problem-import:ip:${getClientIp(c)}`,
    PROBLEM_IMPORT_IP_LIMIT,
  );
  await enforceRateLimit(
    `problem-import:user:${userId}`,
    PROBLEM_IMPORT_USER_LIMIT,
  );
}

/** 帖子点赞/取消点赞：IP + 用户双维度。 */
export async function enforcePostLikeRateLimit(
  c: Context,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `post-like:ip:${getClientIp(c)}`,
    POST_LIKE_IP_LIMIT,
    undefined,
    "allow",
  );
  await enforceRateLimit(
    `post-like:user:${userId}`,
    POST_LIKE_USER_LIMIT,
    undefined,
    "allow",
  );
}

/** 评论点赞/取消点赞：IP + 用户双维度。 */
export async function enforceCommentLikeRateLimit(
  c: Context,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `comment-like:ip:${getClientIp(c)}`,
    COMMENT_LIKE_IP_LIMIT,
    undefined,
    "allow",
  );
  await enforceRateLimit(
    `comment-like:user:${userId}`,
    COMMENT_LIKE_USER_LIMIT,
    undefined,
    "allow",
  );
}

/** 收藏/取消收藏帖子：IP + 用户双维度。 */
export async function enforceBookmarkRateLimit(
  c: Context,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `bookmark:ip:${getClientIp(c)}`,
    BOOKMARK_IP_LIMIT,
    undefined,
    "allow",
  );
  await enforceRateLimit(
    `bookmark:user:${userId}`,
    BOOKMARK_USER_LIMIT,
    undefined,
    "allow",
  );
}

/** 关注/取关用户：IP + 用户双维度。 */
export async function enforceFollowRateLimit(
  c: Context,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `follow:ip:${getClientIp(c)}`,
    FOLLOW_IP_LIMIT,
    undefined,
    "allow",
  );
  await enforceRateLimit(
    `follow:user:${userId}`,
    FOLLOW_USER_LIMIT,
    undefined,
    "allow",
  );
}

/** 举报：IP + 用户双维度，阈值更严格（防止举报轰炸）。 */
export async function enforceReportRateLimit(
  c: Context,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `report:ip:${getClientIp(c)}`,
    REPORT_IP_LIMIT,
    undefined,
    "allow",
  );
  await enforceRateLimit(
    `report:user:${userId}`,
    REPORT_USER_LIMIT,
    undefined,
    "allow",
  );
}

/**
 * 每日签到：按账号维度限流。
 *
 * 只做账号维度、不做 IP 维度：机房/校园 NAT 下多个学生共用出口 IP，IP 窗口会让
 * 同班同学互相顶掉签到。
 */
export async function enforceCheckinRateLimit(userId: string): Promise<void> {
  await enforceRateLimit(
    `checkin:user:${userId}`,
    CHECKIN_USER_LIMIT,
    "签到请求过于频繁，请稍后再试",
    "allow",
  );
}

/**
 * 邮件投递回执：按来源 IP 维度限流。
 *
 * 无账号上下文（厂商回调），只能按 IP 计数；签名校验在限流之后仍然执行，
 * 限流不替代验签。
 */
export async function enforceEmailDeliveryEventRateLimit(
  c: Context,
): Promise<void> {
  await enforceRateLimit(
    `email-delivery:ip:${getClientIp(c)}`,
    EMAIL_DELIVERY_EVENT_IP_LIMIT,
    "邮件回执请求过于频繁，请稍后重试",
  );
}
