/**
 * PR-7 X-Forwarded-For 信任修复测试。
 *
 * 覆盖：
 * - TRUSTED_PROXIES 已配置：从右往左找首个非代理 IP
 * - TRUSTED_PROXIES 未配置 + 生产环境：返 unknown（防御性）
 * - TRUSTED_PROXIES 未配置 + 开发环境：信任首项（向后兼容）
 * - 无 XFF：使用 X-Real-IP / 返 unknown
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { resetDbForTest } from "../../src/db/connection.ts";

import { updateSetting } from "../../src/services/system-settings.ts";
import {
  _resetSystemSettingsForTest,
  initSystemSettings,
} from "../../src/services/system-settings.ts";
import {
  _resetEnvSnapshotForTest,
  snapshotEnv,
} from "../../src/lib/env-snapshot.ts";

// 模块级 bootstrap：创建 PGlite schema（含 system_settings）
await resetDbForTest();
snapshotEnv();

const app = new Hono();
app.get("/ip", (c) => c.json({ ip: getClientIp(c) }));

function restoreNojEnv() {
  const nojEnv = Deno.env.get("NOJ_ENV") ?? "";
  return () => Deno.env.set("NOJ_ENV", nojEnv);
}

Deno.test({
  name: "xff-trust: 无 XFF / 无 X-Real-IP 返 unknown",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await app.request("/ip");
    const body = await res.json();
    assertEquals(body.ip, "unknown");
  },
});

Deno.test({
  name: "xff-trust: 仅 X-Real-IP 头时返回该值",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await app.request("/ip", {
      headers: { "X-Real-IP": "203.0.113.42" },
    });
    const body = await res.json();
    assertEquals(body.ip, "203.0.113.42");
  },
});

Deno.test({
  name: "xff-trust: TRUSTED_PROXIES 配置时从右往左找首个非代理 IP",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetSystemSettingsForTest();
    await initSystemSettings();
    await updateSetting("trusted_proxies", "10.0.0.1,10.0.0.2", "0");

    // XFF = "1.1.1.1, 10.0.0.1, 10.0.0.2"：从右往左，10.0.0.2 / 10.0.0.1 都是代理
    // 首个非代理 IP = "1.1.1.1"
    const res = await app.request("/ip", {
      headers: {
        "X-Forwarded-For": "1.1.1.1, 10.0.0.1, 10.0.0.2",
      },
    });
    const body = await res.json();
    assertEquals(body.ip, "1.1.1.1");

    // 清理
    await updateSetting("trusted_proxies", "", "0");
    _resetEnvSnapshotForTest();
  },
});

Deno.test({
  name: "xff-trust: TRUSTED_PROXIES 配置时单 IP XFF 被识别为代理则返 unknown",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetSystemSettingsForTest();
    await initSystemSettings();
    await updateSetting("trusted_proxies", "10.0.0.1", "0");

    const res = await app.request("/ip", {
      headers: { "X-Forwarded-For": "10.0.0.1" },
    });
    const body = await res.json();
    assertEquals(body.ip, "unknown");

    await updateSetting("trusted_proxies", "", "0");
    _resetEnvSnapshotForTest();
  },
});

Deno.test({
  name: "xff-trust: 未配置 TRUSTED_PROXIES + 开发环境 → 信任 XFF 首项",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const restoreEnv = restoreNojEnv();
    _resetEnvSnapshotForTest();
    Deno.env.set("NOJ_ENV", "");
    _resetSystemSettingsForTest();
    await initSystemSettings();
    // 确保 trusted_proxies 为空
    await updateSetting("trusted_proxies", "", "0");
    _resetSystemSettingsForTest(); // 重新初始化但保留 DB 中的空设置

    const res = await app.request("/ip", {
      headers: { "X-Forwarded-For": "198.51.100.7" },
    });
    const body = await res.json();
    assertEquals(body.ip, "198.51.100.7");

    restoreEnv();
    _resetEnvSnapshotForTest();
  },
});

Deno.test({
  name: "xff-trust: 未配置 TRUSTED_PROXIES + 生产环境 → 返 unknown（防御）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const restoreEnv = restoreNojEnv();
    _resetEnvSnapshotForTest();
    Deno.env.set("NOJ_ENV", "production");
    _resetSystemSettingsForTest();
    await initSystemSettings();
    await updateSetting("trusted_proxies", "", "0");

    const res = await app.request("/ip", {
      headers: { "X-Forwarded-For": "198.51.100.7" },
    });
    const body = await res.json();
    // 防御性：即使启动校验失败逃逸到运行时，运行时也返 unknown
    assertEquals(body.ip, "unknown");

    restoreEnv();
    _resetEnvSnapshotForTest();
  },
});
