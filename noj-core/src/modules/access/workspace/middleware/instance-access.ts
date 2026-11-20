import type { MiddlewareHandler } from "hono";
import { UnauthorizedError } from "../../../../shared/base/errors.ts";
import { optionalAuthMiddleware } from "../../identity/middleware/auth.ts";
import { getInstanceAccessPolicy } from "../services/instance.ts";

/** 私有实例的最外层读门控，登录/验证/法律信息保持可进入。 */
export const instanceAccessMiddleware: MiddlewareHandler = async (c, next) => {
  if (getInstanceAccessPolicy().access === "public") return await next();
  const path = c.req.path;
  if (
    path.startsWith("/api/v1/auth/") || path === "/api/v1/instance" ||
    path === "/api/v1/site/meta" || path.startsWith("/api/v1/legal/")
  ) return await next();
  await optionalAuthMiddleware(c, async () => {});
  if (!c.get("userId")) {
    throw new UnauthorizedError("此实例需要登录", "INSTANCE_LOGIN_REQUIRED");
  }
  return await next();
};
