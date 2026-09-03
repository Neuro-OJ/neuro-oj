import { Hono } from "hono";
import type { AuthEnv } from "../../../middleware/auth.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { ValidationError } from "./../../../shared/base/errors.ts";
import { addIpBan, listIpBans, removeIpBan } from "../services/banlist.ts";

/**
 * 管理端 IP 黑名单路由（issue #102，挂载前缀 /api/v1/admin，见 admin/index.ts）。
 *
 * 提供：
 * - GET    /blacklist      黑名单列表（分页 + 模糊搜索）
 * - POST   /blacklist      添加黑名单条目
 * - DELETE /blacklist/:id  删除黑名单条目
 */
const router = new Hono<AuthEnv>();

/**
 * 管理员列出 IP 黑名单（分页 + 模糊搜索）。
 * GET /api/v1/admin/blacklist?page=&per_page=&keyword=
 */
router.get("/blacklist", async (c) => {
  let page = parseInt(c.req.query("page") ?? "1", 10);
  let perPage = parseInt(c.req.query("per_page") ?? "20", 10);
  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(perPage) || perPage < 1) perPage = 20;
  if (perPage > 100) perPage = 100;

  const keyword = c.req.query("keyword") || undefined;
  const result = await listIpBans({ page, perPage, keyword });
  return c.json({ data: result.data, pagination: result.pagination });
});

/**
 * 管理员添加 IP 黑名单。
 * POST /api/v1/admin/blacklist
 * body: { ip_or_cidr, reason?, expires_at? }
 */
router.post("/blacklist", async (c) => {
  const body = await parseJsonBody<{
    ip_or_cidr: string;
    reason?: string;
    expires_at?: string | null;
  }>(c);
  if (!body.ip_or_cidr) {
    throw new ValidationError("缺少必填字段：ip_or_cidr");
  }
  const ban = await addIpBan(body, c.get("userId"));
  return c.json({ data: ban }, 201);
});

/**
 * 管理员删除 IP 黑名单条目。
 * DELETE /api/v1/admin/blacklist/:id
 */
router.delete("/blacklist/:id", async (c) => {
  const id = c.req.param("id") as string;
  await removeIpBan(id, c.get("userId"));
  return c.body(null, 204);
});

export default router;
