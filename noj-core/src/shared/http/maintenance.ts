/**
 * 维护模式中间件（PR-2 死开关），从 app.ts 抽出以便单测与复用。
 *
 * 当维护模式开启时：
 * - GET/HEAD/OPTIONS 请求放行（用户仍可浏览、查状态）
 * - `/api/v1/internal/*` 写请求放行（内部端点自带服务凭据，排空 CLI 依赖）
 * - 其余 POST/PUT/PATCH/DELETE 请求返回 503 + `MAINTENANCE` code
 *
 * 设计取舍：
 * - 不缓存 maintenance_mode：管理后台切换后下一次请求立即生效
 * - 不阻塞 /health：该中间件只挂在 `/api/v1/*` 上
 * - shared 层不反向依赖业务域：开关读取器由组合根（app.ts）注入
 */

import type { Context, Next } from "hono";

/** 内部端点路径前缀：维护模式下放行写请求（端点自身校验服务凭据）。 */
export const INTERNAL_API_PATH_PREFIX = "/api/v1/internal/";

/** 维护模式开关读取器（由组合根注入，避免 shared 层依赖业务域）。 */
export type MaintenanceModeReader = () => boolean;

/**
 * 创建维护模式中间件。
 *
 * @param isMaintenance 读取当前维护模式开关；每次请求实时调用，不缓存
 * @returns Hono 中间件
 */
export function createMaintenanceMode(
  isMaintenance: MaintenanceModeReader,
): (c: Context, next: Next) => Promise<Response | void> {
  return function maintenanceMode(
    c: Context,
    next: Next,
  ): Promise<Response | void> {
    if (!isMaintenance()) {
      return next();
    }

    const method = c.req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }

    // 内部端点由服务凭据保护，维护模式下仍需可用（进入/查询排空状态）。
    if (c.req.path.startsWith(INTERNAL_API_PATH_PREFIX)) {
      return next();
    }

    return Promise.resolve(
      c.json(
        {
          error: "系统维护中，请稍后再试",
          code: "MAINTENANCE",
        },
        503,
      ),
    );
  };
}
