import type { MiddlewareHandler } from "hono";
import type { AuthEnv } from "../../identity/index.ts";
import { enforceEducationWriteRateLimit } from "../../system/index.ts";

/** 仅安装在教学写端点，避免多个 router 的路径中间件对同一请求重复扣额。 */
export const educationWriteRateLimit: MiddlewareHandler<AuthEnv> = async (
  c,
  next,
) => {
  await enforceEducationWriteRateLimit(c.req.param("slug")!, c.var.userId);
  await next();
};
