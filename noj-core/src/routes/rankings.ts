import { Hono } from "hono";
import type { OptionalAuthEnv } from "../middleware/auth.ts";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.ts";
import { getCheckinLeaderboard } from "../services/checkin.ts";
import { getGlobalRankings, getMyRanking } from "../services/rankings.ts";
import { buildPaginationMeta, parsePagination } from "../lib/pagination.ts";

const router = new Hono<OptionalAuthEnv>();

/**
 * 全站用户榜单。
 * GET /api/v1/rankings?page=1&limit=50
 * 公开访问，无需认证。
 */
router.get("/", async (c) => {
  // PR-6 评审修订：使用 parsePagination helper 替换 9 行样板
  const { page, perPage } = parsePagination(c, {
    defaultPerPage: 50,
    maxPerPage: 100,
    pageField: "page",
    perPageField: "limit",
  });
  // rankings service 仍用 page + limit 参数（不是 offset）
  const { data, total } = await getGlobalRankings({ page, limit: perPage });

  return c.json({
    data,
    pagination: buildPaginationMeta(page, perPage, total),
  });
});

/**
 * 当前登录用户的排名。
 * GET /api/v1/rankings/me
 * 需登录。未上榜（无通过记录）返回 null。
 */
router.get("/me", authMiddleware, async (c) => {
  const userId = c.var.userId as string;
  const row = await getMyRanking(userId);
  return c.json({ data: row });
});

/**
 * 签到活跃榜（issue #184）。
 * GET /api/v1/rankings/checkin?month=YYYY-MM&page=1&per_page=20
 * 公开只读；登录时响应额外包含 user_rank。
 */
router.get("/checkin", optionalAuthMiddleware, async (c) => {
  const { page, perPage } = parsePagination(c, {
    defaultPerPage: 20,
    maxPerPage: 100,
    perPageField: "per_page",
  });
  const result = await getCheckinLeaderboard(
    c.req.query("month") ?? undefined,
    page,
    perPage,
    c.var.userId,
  );
  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(page, perPage, result.total),
    user_rank: result.user_rank,
  });
});

export default router;
