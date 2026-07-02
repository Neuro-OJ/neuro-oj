import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { getGlobalRankings, getMyRanking } from "../services/rankings.ts";
import { BadRequestError } from "../lib/errors.ts";

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
  const pageRaw = c.req.query("page") ?? "1";
  const limitRaw = c.req.query("limit") ?? "50";

  const page = Number.parseInt(pageRaw, 10);
  if (!Number.isFinite(page)) {
    throw new BadRequestError("page 必须为整数");
  }

  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isFinite(limit)) {
    throw new BadRequestError("limit 必须为整数");
  }

  const { data, total } = await getGlobalRankings({ page, limit });
  const perPage = Math.min(Math.max(limit, 1), 100);
  const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);

  return c.json({
    data,
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: totalPages,
    },
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
