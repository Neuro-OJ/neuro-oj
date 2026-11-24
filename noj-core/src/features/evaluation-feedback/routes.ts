import { Hono, type MiddlewareHandler } from "hono";
import { type AuthEnv, authMiddleware } from "../../modules/access/index.ts";
import {
  type FeedbackServiceDeps,
  getSelfTestFeedback,
  getSubmissionFeedback,
} from "./service.ts";

/**
 * 构建 AI 评测可视化反馈路由（挂在 `/api/v1` 下）。
 */
export function createEvaluationFeedbackRouter(
  deps?: FeedbackServiceDeps,
  auth: MiddlewareHandler<AuthEnv> = authMiddleware,
): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>();

  router.get(
    "/domains/:slug/submissions/:id/feedback",
    auth,
    async (c) => {
      const data = await getSubmissionFeedback(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId,
        {
          attemptId: c.req.query("attempt_id"),
          includeMessages: c.req.query("include_messages"),
        },
        deps,
      );
      c.header("Cache-Control", "no-store");
      return c.json({ data });
    },
  );

  router.get(
    "/domains/:slug/self-tests/:id/feedback",
    auth,
    async (c) => {
      const data = await getSelfTestFeedback(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId,
        c,
        {
          includeMessages: c.req.query("include_messages"),
        },
        deps,
      );
      c.header("Cache-Control", "no-store");
      return c.json({ data });
    },
  );

  return router;
}

export const evaluationFeedbackRouter = createEvaluationFeedbackRouter();
