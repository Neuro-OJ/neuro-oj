import type { Context, MiddlewareHandler } from "hono";
import { assertVersion } from "../services/admin-version.ts";

export { assertVersion };

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
