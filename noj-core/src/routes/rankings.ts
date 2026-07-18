import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { getGlobalRankings, getMyRanking } from "../services/rankings.ts";
import { buildPaginationMeta, parsePagination } from "../lib/pagination.ts";

type Env = {
  Variables: {
    userId: string;
    userRole: string;
  };
};

const router = new Hono<Env>();

/**
 * 全站用户榜单。
 * GET /api/v1/rankings?page=1&limit=50
 * 公开访问，无需认证。
 */
router.get("/", async (c) => {
  // PR-6 评审修订：使用 parsePagination helper 替换 9 行样板
  const { page, perPage, offset } = parsePagination(c, {
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
    // offset 仅用于未来若改用 keyset 分页的扩展性
    _offset: offset,
  });
});

/**
 * 当前登录用户的排名。
 * GET /api/v1/rankings/me
 * 需登录。未上榜（无通过记录）返回 null。
 */
router.get("/me", authMiddleware, async (c) => {
  const userId = c.var.userId!;
  const row = await getMyRanking(userId);
  return c.json({ data: row });
});

export default router;
