import { Hono } from "hono";
import {
  type AuthEnv,
  authMiddleware,
  optionalAuthMiddleware,
  resolveUserId,
} from "../../modules/access/index.ts";
import { UnauthorizedError } from "../../shared/base/errors.ts";
import { enforceCheckinRateLimit } from "../../modules/platform/index.ts";
import {
  checkIn,
  getCheckinHistory,
  getCheckinStats,
  getTodayCheckIn,
} from "./service.ts";

/** 签到路由，挂在 `/api/v1` 下（原 `identityRouter.route("/checkin", …)`）。 */
export const checkinRouter = new Hono<AuthEnv>();
const prefix = "/checkin";

/**
 * 签到。
 * POST /api/v1/checkin
 *
 * 按天幂等不等于可以无限调用：重复请求仍会开事务写 `check_ins` 并重算连续天数，
 * 因此加账号维度写窗口（60s/10）。只按账号计数，不按 IP——NAT 下同班学生会互相顶掉。
 */
checkinRouter.post(prefix, authMiddleware, async (c) => {
  const userId = c.var.userId as string;
  await enforceCheckinRateLimit(userId);
  const result = await checkIn(userId);
  return c.json({ data: result });
});

/**
 * 获取今日签到状态。
 * GET /api/v1/checkin/today
 */
checkinRouter.get(`${prefix}/today`, authMiddleware, async (c) => {
  const userId = c.var.userId as string;
  const result = await getTodayCheckIn(userId);
  return c.json({ data: result });
});

/**
 * 签到统计（issue #184）。
 * GET /api/v1/checkin/stats?month=YYYY-MM&user_id=xxx
 *
 * 不传 user_id 时返回当前登录用户统计（需登录）；
 * 传 user_id 时公开返回该用户统计（个人主页活跃度卡片展示他人数据）。
 */
checkinRouter.get(`${prefix}/stats`, optionalAuthMiddleware, async (c) => {
  const targetUserId = c.req.query("user_id") ?? c.var.userId;
  if (!targetUserId) {
    throw new UnauthorizedError("未提供认证令牌");
  }
  const data = await getCheckinStats(
    await resolveUserId(targetUserId),
    c.req.query("month") ?? undefined,
  );
  return c.json({ data });
});

/**
 * 签到历史（issue #184）。
 * GET /api/v1/checkin/history?days=30|90|365&user_id=xxx
 * 语义与 /stats 一致：user_id 缺省时返回本人（需登录）。
 */
checkinRouter.get(`${prefix}/history`, optionalAuthMiddleware, async (c) => {
  const targetUserId = c.req.query("user_id") ?? c.var.userId;
  if (!targetUserId) {
    throw new UnauthorizedError("未提供认证令牌");
  }
  const days = Number(c.req.query("days") ?? "30");
  const data = await getCheckinHistory(await resolveUserId(targetUserId), days);
  return c.json({ data });
});
