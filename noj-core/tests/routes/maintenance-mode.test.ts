/**
 * 维护模式中间件透传测试（P1d）。
 *
 * 验证 app.ts 的全局维护中间件语义：
 * - 维护开启：普通写请求 503 + code=MAINTENANCE；GET 放行；/api/v1/internal/* 写请求放行；
 * - 维护关闭：全部放行。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { resetDbForTest } from "../helpers/db.ts";
import {
  _resetSystemSettingsForTest,
  initSystemSettings,
  updateSetting,
} from "../../src/modules/platform/system/index.ts";
import {
  _resetEnvSnapshotForTest,
  snapshotEnv,
} from "../../src/modules/platform/system/services/env-snapshot.ts";

const INTERNAL_TOKEN = "test-maintenance-internal-token-0123456789";

/** 设置内部凭据并返回恢复函数（含 env 快照重置）。 */
function useToken(token = INTERNAL_TOKEN): () => void {
  const previous = Deno.env.get("NOJ_INTERNAL_SERVICE_TOKEN");
  Deno.env.set("NOJ_INTERNAL_SERVICE_TOKEN", token);
  _resetEnvSnapshotForTest();
  snapshotEnv();
  return () => {
    if (previous === undefined) Deno.env.delete("NOJ_INTERNAL_SERVICE_TOKEN");
    else Deno.env.set("NOJ_INTERNAL_SERVICE_TOKEN", previous);
    _resetEnvSnapshotForTest();
    snapshotEnv();
  };
}

/** 普通写请求（登录失败也是业务响应，不应被维护中间件拦截为 503）。 */
function loginRequest(
  app: ReturnType<typeof createApp>,
): Response | Promise<Response> {
  return app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      login: "maintenance-probe",
      password: "bad-password",
    }),
  });
}

/** 内部排空写请求。 */
function drainEnterRequest(
  app: ReturnType<typeof createApp>,
  token = INTERNAL_TOKEN,
): Response | Promise<Response> {
  return app.request("/api/v1/internal/drain/enter", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

Deno.test({
  name: "maintenance-mode: 维护关闭时普通写请求与内部写请求全部放行",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const restoreToken = useToken();
    await resetDbForTest();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    try {
      await updateSetting("maintenance_mode", false, "0");
      const app = createApp();
      const login = await loginRequest(app);
      assertEquals(login.status !== 503, true);
      assertEquals((await login.json()).code !== "MAINTENANCE", true);

      assertEquals((await app.request("/health")).status, 200);

      const enter = await drainEnterRequest(app);
      assertEquals(enter.status, 200);
    } finally {
      await updateSetting("maintenance_mode", false, "0").catch(() => {});
      restoreToken();
    }
  },
});

Deno.test({
  name:
    "maintenance-mode: 维护开启时普通写 503 MAINTENANCE、GET 放行、内部写放行",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const restoreToken = useToken();
    await resetDbForTest();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    try {
      await updateSetting("maintenance_mode", true, "0");
      const app = createApp();

      const login = await loginRequest(app);
      assertEquals(login.status, 503);
      assertEquals((await login.json()).code, "MAINTENANCE");

      // GET 仍可用（健康检查、查状态）
      assertEquals((await app.request("/health")).status, 200);

      // 内部端点自带凭据，不受维护中间件拦截：正确凭据 200，错误凭据 401
      // （若被维护中间件拦截会得到 503 MAINTENANCE）。
      const enter = await drainEnterRequest(app);
      assertEquals(enter.status, 200);
      assertEquals(await enter.json(), {
        data: { maintenance: true, changed: false },
      });
      const unauthorized = await drainEnterRequest(app, "wrong-token");
      assertEquals(unauthorized.status, 401);
    } finally {
      await updateSetting("maintenance_mode", false, "0").catch(() => {});
      restoreToken();
    }
  },
});
