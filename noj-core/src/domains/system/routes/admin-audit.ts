import { Hono } from "hono";
import type { AuthEnv } from "../../../middleware/auth.ts";
import { listAuditLogs } from "../services/audit-log.ts";
import type { AuditAction } from "../../../types/audit-log.ts";

/**
 * 管理端审计日志路由（issue #101，挂载前缀 /api/v1/admin，见 admin/index.ts）。
 *
 * 提供：
 * - GET /audit-logs 审计日志列表（分页 + 筛选）
 */
const router = new Hono<AuthEnv>();

/**
 * 管理员查询审计日志（分页 + 筛选）。
 * GET /api/v1/admin/audit-logs
 *
 * Query:
 *   page, per_page (default 20, max 100)
 *   admin_id?, action?, from?, to?  (ISO 8601)
 */
router.get("/audit-logs", async (c) => {
  let page = parseInt(c.req.query("page") ?? "1", 10);
  let perPage = parseInt(c.req.query("per_page") ?? "20", 10);
  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(perPage) || perPage < 1) perPage = 20;
  if (perPage > 100) perPage = 100;

  const result = await listAuditLogs({
    page,
    perPage,
    admin_id: c.req.query("admin_id") || undefined,
    action: (c.req.query("action") || undefined) as AuditAction | undefined,
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
  });
  return c.json({ data: result.data, pagination: result.pagination });
});

export default router;
