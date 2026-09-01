import { Hono } from "hono";
import type { OptionalAuthEnv } from "../../../middleware/auth.ts";
import {
  authMiddleware,
  optionalAuthMiddleware,
} from "../../../middleware/auth.ts";
import { UnauthorizedError } from "../../../lib/errors.ts";
import { resolveUserId } from "../services/users/users-id.ts";
import {
  checkIn,
  getCheckinHistory,
  getCheckinStats,
  getTodayCheckIn,
} from "../services/checkin.ts";

const router = new Hono<OptionalAuthEnv>();

/**
 * 签到。
 * POST /api/v1/checkin
 */
router.post("/", authMiddleware, async (c) => {
  const userId = c.var.userId as string;
  const result = await checkIn(userId);
  return c.json({ data: result });
});

/**
 * 获取今日签到状态。
 * GET /api/v1/checkin/today
 */
router.get("/today", authMiddleware, async (c) => {
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
router.get("/stats", optionalAuthMiddleware, async (c) => {
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
router.get("/history", optionalAuthMiddleware, async (c) => {
  const targetUserId = c.req.query("user_id") ?? c.var.userId;
  if (!targetUserId) {
    throw new UnauthorizedError("未提供认证令牌");
  }
  const days = Number(c.req.query("days") ?? "30");
  const data = await getCheckinHistory(await resolveUserId(targetUserId), days);
  return c.json({ data });
});

export default router;
