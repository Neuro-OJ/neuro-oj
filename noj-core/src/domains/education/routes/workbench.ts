import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "../../identity/index.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import { getEducationWorkbench } from "../services/workbench.ts";

/** 工作台返回获授权任务摘要；求助正文仍通过单资源接口读取。 */
export const educationWorkbenchRouter = new Hono<AuthEnv>();
for (
  const [path, mode] of [["teaching", "teaching"], [
    "my-learning",
    "learning",
  ]] as const
) {
  educationWorkbenchRouter.get(
    `/domains/:slug/${path}`,
    authMiddleware,
    async (c) => {
      const { page } = parsePagination(c, {
        defaultPerPage: 20,
        maxPerPage: 20,
      });
      c.header("Cache-Control", "no-store");
      return c.json({
        data: await getEducationWorkbench(
          c.req.param("slug")!,
          c.var.userId,
          mode,
          page,
        ),
      });
    },
  );
}
