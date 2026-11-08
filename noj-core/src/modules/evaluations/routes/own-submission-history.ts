import { Hono } from "hono";
import { authMiddleware } from "../../access/identity/middleware/auth.ts";
import { type AuthEnv } from "../../../shared/http/hono-env.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import { getOwnSubmissionHistory } from "../services/own-submission-history.ts";
import { downloadOwnArtifact } from "../services/own-artifact.ts";
/** 本人跨域历史独立于当前导航工作空间，不授予题面、数据或他人提交访问。 */
export const ownSubmissionHistoryRouter = new Hono<AuthEnv>();
for (const path of ["/me/submissions", "/me/submissions/*"]) {
  ownSubmissionHistoryRouter.use(path, authMiddleware, async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
}
ownSubmissionHistoryRouter.get(
  "/me/submissions/submission/:id/artifact",
  async (c) => {
    c.header("Cache-Control", "private, no-store");
    return await downloadOwnArtifact(c.var.userId, c.req.param("id"));
  },
);
ownSubmissionHistoryRouter.get("/me/submissions/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  if (kind !== "submission" && kind !== "objective") {
    throw new NotFoundError("提交不存在");
  }
  return c.json({
    data: await getOwnSubmissionHistory(c.var.userId, kind, c.req.param("id")),
  });
});
