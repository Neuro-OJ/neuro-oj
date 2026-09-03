import { Hono } from "hono";
import type { AuthEnv } from "../../../middleware/auth.ts";
import { parseJsonBody } from "../../../lib/request.ts";
import { BadRequestError } from "./../../../shared/base/errors.ts";
import {
  listSettings,
  resetSetting,
  updateSetting,
} from "../services/system-settings.ts";

/**
 * 管理端系统设置路由（issue #99，挂载前缀 /api/v1/admin，见 admin/index.ts）。
 *
 * 提供：
 * - GET    /settings          列出所有设置项（DB-backed 5 项 + env-only N 项）
 * - PUT    /settings/:key     更新单个设置项（UPSERT）
 * - DELETE /settings/:key     重置单个设置项（回退到 env/default）
 */
const router = new Hono<AuthEnv>();

/**
 * 列出所有系统设置项（DB-backed 5 项 + env-only N 项）。
 * GET /api/v1/admin/settings
 *
 * 注意：必须先注册静态路径 `/settings`，再注册参数化路径 `/settings/:key`，
 * 否则 `GET /settings` 会被 `/settings/:key` 误匹配。
 */
router.get("/settings", async (c) => {
  const items = await listSettings();
  return c.json({ data: items });
});

/**
 * 更新单个设置项（UPSERT）。
 * PUT /api/v1/admin/settings/:key
 * body: { value: boolean | string }
 */
router.put("/settings/:key", async (c) => {
  const key = c.req.param("key") as string;
  const body = await parseJsonBody<{ value: unknown }>(c);
  if (!("value" in body)) {
    throw new BadRequestError("请求体必须包含 value 字段");
  }
  const item = await updateSetting(key, body.value, c.get("userId"));
  return c.json({ data: item }, 200);
});

/**
 * 重置单个设置项（DELETE FROM system_settings，回退到 env/default）。
 * DELETE /api/v1/admin/settings/:key
 * 幂等：DB 不存在也正常返回 204。
 */
router.delete("/settings/:key", async (c) => {
  const key = c.req.param("key") as string;
  await resetSetting(key, c.get("userId"));
  return c.body(null, 204);
});

export default router;
