/**
 * Core 内部维护/排空路由（P1d）。
 *
 * 供容器内维护 CLI（`/app/bin/noj maintain ...`）与 noj-cli 自动排空调用，
 * 不面向浏览器/普通用户，凭据为独立的内部服务 token：
 *
 * - `GET  /api/v1/internal/drain/status` → 200 `{data: DrainStatusData}`
 * - `POST /api/v1/internal/drain/enter`  → 200 `{data: {maintenance: true, changed}}`
 * - `POST /api/v1/internal/drain/exit`   → 200 `{data: {maintenance: false, changed}}`
 *
 * 语义：
 * - 凭据读 bootstrap 配置 `NOJ_INTERNAL_SERVICE_TOKEN`（未设置 → 503 drain_unavailable；
 *   错误 → 401，常量时间比较）；不读 `NOJ_LLM_SERVICE_TOKEN`。
 * - enter/exit 幂等：已是目标状态时不重复写设置（`changed=false`）。
 * - 路由挂载在维护中间件之后；维护中间件放行 `/api/v1/internal/*`
 *   （内部端点自带凭据）。
 */

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { ROOT_USER_ID } from "../../../shared/base/constants.ts";
import { AppError, UnauthorizedError } from "../../../shared/base/errors.ts";
import {
  type DrainStatusDeps,
  readDrainStatus,
} from "../services/drain-status.ts";
import { getSetting, updateSetting } from "../services/system-settings.ts";

/** 内部服务凭据的 bootstrap 配置键（未设置时 drain 端点不可用）。 */
const INTERNAL_SERVICE_TOKEN_KEY = "NOJ_INTERNAL_SERVICE_TOKEN";

/** 提取 `Authorization: Bearer <token>` 中的 token；缺失时返回空串。 */
function bearerToken(c: Context): string {
  const header = c.req.header("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * 内部服务凭据守卫：未配置 → 503 drain_unavailable；错误 → 401。
 *
 * 比较使用 timingSafeEqual 且先比较长度，避免短路比较泄露长度/前缀信息。
 */
async function requireInternalServiceToken(
  c: Context,
  next: Next,
): Promise<void> {
  const configured = String(
    getSetting(INTERNAL_SERVICE_TOKEN_KEY)?.value ?? "",
  );
  if (!configured) {
    throw new AppError(
      "内部服务凭据未配置（NOJ_INTERNAL_SERVICE_TOKEN），排空端点不可用",
      503,
      "drain_unavailable",
    );
  }
  const encoder = new TextEncoder();
  const expected = encoder.encode(configured);
  const actual = encoder.encode(bearerToken(c));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new UnauthorizedError("内部服务凭据无效");
  }
  await next();
}

/** enter/exit 的响应 data。 */
interface MaintenanceChange {
  maintenance: boolean;
  changed: boolean;
}

/**
 * 幂等切换维护模式。
 *
 * 复用 system-settings 的 updateSetting（含缓存重新加载与跨副本失效通知），
 * 已是目标值时不重复写（避免每次 enter/exit 都产生审计噪音）。
 *
 * @param target 目标维护模式
 * @returns 当前维护模式与是否发生变更
 */
async function setMaintenanceMode(target: boolean): Promise<MaintenanceChange> {
  const current = getSetting("maintenance_mode")?.value === true;
  if (current === target) return { maintenance: target, changed: false };
  await updateSetting("maintenance_mode", target, ROOT_USER_ID);
  return { maintenance: target, changed: true };
}

/**
 * 创建内部排空路由（挂载到 `/api/v1`）。
 *
 * @param deps 排空状态依赖覆盖：生产由组合根 app.ts 注入 queue health（submission）
 *             与 judge 心跳（observability）；测试可注入 fake
 * @returns Hono 路由实例
 */
export function createInternalDrainRouter(
  deps: Partial<DrainStatusDeps> = {},
): Hono {
  const router = new Hono();
  router.use("/internal/*", requireInternalServiceToken);

  router.get("/internal/drain/status", async (c) => {
    const data = await readDrainStatus(deps);
    // 排空状态是瞬时值，禁止任何中间缓存（代理/浏览器）。
    c.header("Cache-Control", "no-store");
    return c.json({ data });
  });

  router.post(
    "/internal/drain/enter",
    async (c) => c.json({ data: await setMaintenanceMode(true) }),
  );

  router.post(
    "/internal/drain/exit",
    async (c) => c.json({ data: await setMaintenanceMode(false) }),
  );

  return router;
}
