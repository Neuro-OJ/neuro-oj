/**
 * 审计修复（NOJ-093/094/096/069）使用的高风险端点限流。
 *
 * 与登录限流一样走 Redis 固定窗口，并在 Redis 不可用时 fail-closed（503）。
 * 阈值故意保持宽松以兼容现有 API 客户端，同时阻止无差别批量刷接口。
 */

import { RateLimitedError } from "../../../../shared/base/errors.ts";
import {
  checkRateLimit,
  type RateLimitConfig,
  rateLimitHeaders,
} from "../../../../shared/rate-limit/rate-limit.ts";
import { getClientIp, isRateLimitEnabled } from "./rate-limit-env.ts";
import type { Context } from "hono";

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

export const SUBMISSION_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

export const SUBMISSION_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

export const SELF_TEST_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 30,
};

export const SELF_TEST_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 4,
};

export const CONTEST_SUBMISSION_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

export const CONTEST_SUBMISSION_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
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

export const OBJECTIVE_SUBMIT_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 60,
};

export const OBJECTIVE_SUBMIT_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 60,
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

export async function enforceRateLimit(
  key: string,
  cfg: RateLimitConfig,
  message = "请求过于频繁，请稍后重试",
): Promise<void> {
  if (!isRateLimitEnabled()) return;
  const result = await checkRateLimit(
    `hardening:${normalizeLimitKey(key)}`,
    cfg,
  );
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
  );
  await enforceRateLimit(
    `problem-create:user:${userId}`,
    PROBLEM_CREATE_USER_LIMIT,
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
  );
  await enforceRateLimit(
    `post-like:user:${userId}`,
    POST_LIKE_USER_LIMIT,
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
  );
  await enforceRateLimit(
    `comment-like:user:${userId}`,
    COMMENT_LIKE_USER_LIMIT,
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
  );
  await enforceRateLimit(
    `bookmark:user:${userId}`,
    BOOKMARK_USER_LIMIT,
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
  );
  await enforceRateLimit(
    `follow:user:${userId}`,
    FOLLOW_USER_LIMIT,
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
  );
  await enforceRateLimit(
    `report:user:${userId}`,
    REPORT_USER_LIMIT,
  );
}
