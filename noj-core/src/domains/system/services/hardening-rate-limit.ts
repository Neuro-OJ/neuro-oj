/**
 * 审计修复（NOJ-093/094/096/069）使用的高风险端点限流。
 *
 * 与登录限流一样走 Redis 固定窗口，并在 Redis 不可用时 fail-closed（503）。
 * 阈值故意保持宽松以兼容现有 API 客户端，同时阻止无差别批量刷接口。
 */

import { RateLimitedError } from "../../../shared/base/errors.ts";
import {
  checkRateLimit,
  type RateLimitConfig,
  rateLimitHeaders,
} from "../../../shared/rate-limit/rate-limit.ts";
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

/** 注册端点：按客户端 IP 限流。 */
export async function enforceRegisterRateLimit(c: Context): Promise<void> {
  await enforceRateLimit(
    `register:ip:${getClientIp(c)}`,
    REGISTER_LIMIT,
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
