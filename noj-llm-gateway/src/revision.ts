import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/** 配置写入使用调用方读取的资源版本，创建使用 0。 */
export function requireRevision(c: Context): number {
  const header = c.req.header("If-Match");
  if (header === undefined) {
    throw new HTTPException(428, {
      res: c.json({ error: "revision_required" }, 428),
    });
  }
  const raw = header.replace(/^"|"$/g, "");
  const revision = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(revision)) {
    throw new HTTPException(400, {
      res: c.json({ error: "invalid_revision" }, 400),
    });
  }
  return revision;
}
