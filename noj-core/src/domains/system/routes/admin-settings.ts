import { Hono } from "hono";
import type { AuthEnv } from "../../identity/index.ts";
import { parseJsonBody } from "../../../shared/http/request.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { isBootstrap } from "../../../shared/config/settings-registry.ts";
import {
  cleanupBootstrapRow,
  listSettings,
  resetSetting,
  updateSetting,
} from "../services/system-settings.ts";

/**
 * 管理端系统设置路由（issue #99，挂载前缀 /api/v1/admin，见 admin/index.ts）。
 *
 * 提供：
 * - GET    /settings          列出全部配置项（runtime + bootstrap，含元数据）
 * - PUT    /settings/:key     更新 runtime 项（UPSERT）；bootstrap 项返回 400
 * - DELETE /settings/:key     runtime 项重置（回退 env/default）；
 *                             bootstrap 项清理残留 DB 行（幂等）
 */
const router = new Hono<AuthEnv>();

/**
 * 列出全部配置项（runtime + bootstrap）。
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
 * 更新 runtime 项（UPSERT）。bootstrap 项由 service 层拒绝（400）。
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
 * 删除设置：
 * - runtime 项：DELETE system_settings 行，回退到 env/default；
 * - bootstrap 项：清理被忽略的残留 DB 行（值仍由 env 决定）。
 * DELETE /api/v1/admin/settings/:key
 * 幂等：DB 不存在也正常返回 204。
 */
router.delete("/settings/:key", async (c) => {
  const key = c.req.param("key") as string;
  const userId = c.get("userId");
  if (isBootstrap(key)) {
    await cleanupBootstrapRow(key, userId);
  } else {
    await resetSetting(key, userId);
  }
  return c.body(null, 204);
});

export default router;
