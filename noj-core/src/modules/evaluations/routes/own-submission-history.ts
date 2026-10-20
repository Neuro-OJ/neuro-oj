import { Hono } from "hono";
import {
  type AuthEnv,
  authMiddleware,
} from "../../../domains/identity/index.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import {
  buildPaginationMeta,
  parsePagination,
} from "../../../shared/http/pagination.ts";
import {
  getOwnSubmissionHistory,
  listOwnSubmissionHistory,
} from "../services/own-submission-history.ts";
import { downloadOwnArtifact } from "../services/own-artifact.ts";
/** 本人跨域历史独立于当前导航工作空间，不授予题面、数据或他人提交访问。 */
export const ownSubmissionHistoryRouter = new Hono<AuthEnv>();
for (const path of ["/me/submissions", "/me/submissions/*"]) {
  ownSubmissionHistoryRouter.use(path, authMiddleware, async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
}
ownSubmissionHistoryRouter.get("/me/submissions", async (c) => {
  const { page, perPage } = parsePagination(c, { maxPerPage: 100 });
  const result = await listOwnSubmissionHistory(c.var.userId, page, perPage);
  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(page, perPage, result.total),
  });
});
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
