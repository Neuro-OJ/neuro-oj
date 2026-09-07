/**
 * Admin 乐观锁 Hono 中间件。
 *
 * 从 `If-Match` 读取期望版本，并在匹配时校验当前版本。
 * 缺少 `If-Match` 时直接放行（乐观锁只约束显式携带版本的写操作）。
 */
import type { Context, MiddlewareHandler } from "hono";
import { assertVersion } from "../services/admin-version.ts";

export function readVersion(c: Context): string | undefined {
  const header = c.req.header("If-Match");
  if (header) {
    return header.replace(/^"|"$/g, "");
  }
  return undefined;
}

export function adminVersionMiddleware(
  getCurrentVersion: (c: Context) => Promise<string | null | undefined>,
): MiddlewareHandler {
  return async (c, next) => {
    const expected = readVersion(c);
    if (expected) {
      const current = await getCurrentVersion(c);
      assertVersion(current, expected);
    }
    await next();
  };
}
