import { Hono } from "hono";
import {
  type AuthEnv,
  authMiddleware,
  optionalAuthMiddleware,
  resolveUserId,
} from "../../modules/access/index.ts";
import { getUserPracticeRating } from "./service.ts";

/** 练习能力值路由，挂在 `/api/v1` 下。 */
export const practiceRatingRouter = new Hono<AuthEnv>();
const prefix = "/practice-rating";

/**
 * 获取当前登录用户的练习能力值与 Top-N 构成明细。
 * GET /api/v1/practice-rating/me
 */
practiceRatingRouter.get(`${prefix}/me`, authMiddleware, async (c) => {
  const userId = c.var.userId as string;
  c.header("Cache-Control", "no-store");
  const data = await getUserPracticeRating(userId);
  return c.json({ data });
});

/**
 * 获取指定用户的练习能力值与 Top-N 构成明细（支持 UUID 或 username，公开只读）。
 * GET /api/v1/practice-rating/users/:id
 */
practiceRatingRouter.get(
  "/practice-rating/users/:id",
  optionalAuthMiddleware,
  async (c) => {
    const targetId = await resolveUserId(c.req.param("id") ?? "");
    c.header("Cache-Control", "no-store");
    const data = await getUserPracticeRating(targetId);
    return c.json({ data });
  },
);
