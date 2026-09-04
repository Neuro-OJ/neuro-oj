import { Hono } from "hono";
import type { AuthEnv } from "./../middleware/auth.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import {
  createRole,
  deleteRole,
  listPermissions,
  listRoles,
  updateRole,
} from "../services/admin-roles.ts";

/**
 * 管理端 RBAC 路由（挂载前缀 /api/v1/admin，见 admin/index.ts）。
 *
 * 提供：
 * - GET/POST /roles            角色列表 / 创建
 * - PUT/DELETE /roles/:id      角色更新 / 删除
 * - GET /permissions           权限列表（按 resource 分组）
 */
const router = new Hono<AuthEnv>();

/**
 * 管理员获取角色列表。
 * GET /api/v1/admin/roles
 */
router.get("/roles", async (c) => {
  const result = await listRoles();
  return c.json({ data: result });
});

/**
 * 管理员创建角色。
 * POST /api/v1/admin/roles
 * body: { name, description?, parent_id?, permission_ids? }
 */
router.post("/roles", async (c) => {
  const body = await parseJsonBody<{
    name: string;
    description?: string;
    parent_id?: string;
    permission_ids?: string[];
  }>(c);
  const result = await createRole(body);
  return c.json({ data: result }, 201);
});

/**
 * 管理员编辑角色。
 * PUT /api/v1/admin/roles/:id
 * body: { name?, description?, parent_id?, permission_ids? }
 */
router.put("/roles/:id", async (c) => {
  const id = c.req.param("id") as string;
  const body = await parseJsonBody<{
    name?: string;
    description?: string;
    parent_id?: string | null;
    permission_ids?: string[];
  }>(c);
  const result = await updateRole(id, body);
  return c.json({ data: result });
});

/**
 * 管理员删除角色。
 * DELETE /api/v1/admin/roles/:id
 */
router.delete("/roles/:id", async (c) => {
  const id = c.req.param("id") as string;
  await deleteRole(id);
  return c.body(null, 204);
});

/**
 * 管理员获取权限列表（按 resource 分组）。
 * GET /api/v1/admin/permissions
 */
router.get("/permissions", async (c) => {
  const result = await listPermissions();
  return c.json({ data: result });
});

export default router;
