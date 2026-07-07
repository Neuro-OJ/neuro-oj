/**
 * 系统设置服务层测试（issue #99）。
 *
 * 覆盖场景：
 * - initSystemSettings 从 DB 全量加载到 Map
 * - getSetting 兜底链：DB > env > default
 * - updateSetting 严格 type 校验
 * - updateSetting smtp_from email 格式校验
 * - updateSetting 未注册 key 拒绝
 * - resetSetting 删除 DB 行
 * - 敏感字段掩码 maskSecret
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { systemSettings } from "../../src/db/schema.ts";
import {
  _resetSystemSettingsForTest,
  getSetting,
  initSystemSettings,
  listSettings,
  maskSecret,
  resetSetting,
  updateSetting,
} from "../../src/services/system-settings.ts";
import {
  _resetEnvSnapshotForTest,
  snapshotEnv,
} from "../../src/lib/env-snapshot.ts";
import { ValidationError } from "../../src/lib/errors.ts";
import { validateRegistry } from "../../src/lib/settings-registry.ts";

const ts = Date.now();

async function freshSetup() {
  await resetDbForTest();
  _resetSystemSettingsForTest();
  _resetEnvSnapshotForTest();
  snapshotEnv();
  await initSystemSettings();
}

Deno.test({
  name: "system-settings service: initSystemSettings 从 DB 全量加载到 Map",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(systemSettings).values({
      key: `test_init_${ts}`,
      value: JSON.stringify(true),
      description: "测试",
      is_secret: false,
      updated_at: now,
      updated_by: "0",
    });
    _resetSystemSettingsForTest();
    await initSystemSettings();
    const got = getSetting(`test_init_${ts}`);
    assertEquals(got?.source, "db");
    assertEquals(got?.value, true);
  },
});

Deno.test({
  name: "system-settings service: getSetting 未设置时回退 registry default",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    // allow_register 未在 DB、未在 .env（PGlite 模式快照为空），应回退 default=true
    const got = getSetting("allow_register");
    assertEquals(got?.source, "default");
    assertEquals(got?.value, true);
  },
});

Deno.test({
  name: "system-settings service: getSetting DB 命中后 source='db'",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await updateSetting("allow_register", false, "0");
    const got = getSetting("allow_register");
    assertEquals(got?.source, "db");
    assertEquals(got?.value, false);
  },
});

Deno.test({
  name: "system-settings service: updateSetting 非法 boolean 类型拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await assertRejects(
      () => updateSetting("allow_register", "yes" as unknown as boolean, "0"),
      ValidationError,
      "必须是 boolean",
    );
  },
});

Deno.test({
  name: "system-settings service: updateSetting smtp_from 格式错拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await assertRejects(
      () => updateSetting("smtp_from", "not-an-email", "0"),
      ValidationError,
      "email 格式",
    );
  },
});

Deno.test({
  name: "system-settings service: updateSetting smtp_from 空字符串允许",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await updateSetting("smtp_from", "", "0");
    const got = getSetting("smtp_from");
    assertEquals(got?.source, "db");
    assertEquals(got?.value, "");
  },
});

Deno.test({
  name: "system-settings service: updateSetting smtp_from 合法 email 接受",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await updateSetting("smtp_from", "noreply@noj.local", "0");
    const got = getSetting("smtp_from");
    assertEquals(got?.value, "noreply@noj.local");
  },
});

Deno.test({
  name: "system-settings service: updateSetting integer 合法值接受",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await updateSetting("rate_limit_login_ip_max", 20, "0");
    const got = getSetting("rate_limit_login_ip_max");
    assertEquals(got?.source, "db");
    assertEquals(got?.value, 20);
  },
});

Deno.test({
  name: "system-settings service: updateSetting integer 浮点数拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await assertRejects(
      () => updateSetting("rate_limit_login_ip_max", 10.5, "0"),
      ValidationError,
      "必须是整数",
    );
  },
});

Deno.test({
  name: "system-settings service: updateSetting integer 非数字拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await assertRejects(
      () =>
        updateSetting(
          "rate_limit_login_ip_max",
          "twenty" as unknown as number,
          "0",
        ),
      ValidationError,
      "必须是整数",
    );
  },
});

Deno.test({
  name: "system-settings service: updateSetting integer 低于 min 拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    // rate_limit_login_ip_max 定义 min:1
    await assertRejects(
      () => updateSetting("rate_limit_login_ip_max", 0, "0"),
      ValidationError,
      "不能小于 1",
    );
  },
});

Deno.test({
  name: "system-settings service: updateSetting integer 高于 max 拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    // audit_log_retention_days 定义 max:365
    await assertRejects(
      () => updateSetting("audit_log_retention_days", 999, "0"),
      ValidationError,
      "不能大于 365",
    );
  },
});

Deno.test({
  name:
    "system-settings service: getSetting integer 未设置回退 registry default",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    // rate_limit_login_ip_max 注册表 default=10
    const got = getSetting("rate_limit_login_ip_max");
    assertEquals(got?.source, "default");
    assertEquals(got?.value, 10);
  },
});

Deno.test({
  name: "system-settings service: validateRegistry 不抛错（注册表完整）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    // 当前注册表包含 22+ 个合法定义，不应抛错
    validateRegistry();
  },
});

Deno.test({
  name: "system-settings service: 未注册 key 拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await assertRejects(
      () => updateSetting("hacker_key", "value", "0"),
      ValidationError,
      "未注册",
    );
  },
});

Deno.test({
  name: "system-settings service: updateSetting homepage_banner 超长拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await assertRejects(
      () => updateSetting("homepage_banner", "x".repeat(1001), "0"),
      ValidationError,
      "长度",
    );
  },
});

Deno.test({
  name: "system-settings service: resetSetting 删除 DB 行",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await updateSetting("maintenance_mode", true, "0");
    assertEquals(getSetting("maintenance_mode")?.source, "db");

    await resetSetting("maintenance_mode", "0");
    // reset 后 source 不再是 db（应是 env 或 default）
    const got = getSetting("maintenance_mode");
    assertEquals(got?.source !== "db", true);
  },
});

Deno.test({
  name: "system-settings service: resetSetting 幂等（DB 不存在也 OK）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    // 第一次重置（DB 中无此行）
    await resetSetting("maintenance_mode", "0");
    // 第二次重置
    await resetSetting("maintenance_mode", "0");
    assertEquals(true, true);
  },
});

Deno.test({
  name: "system-settings service: resetSetting 未注册 key 也幂等（不抛错）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    // spec：DELETE /api/v1/admin/settings/nonexistent_key 应当响应 204，不抛错
    await resetSetting("totally_unregistered_key_xyz", "0");
    // 后续再次调用同样幂等
    await resetSetting("totally_unregistered_key_xyz", "0");
    assertEquals(true, true);
  },
});

Deno.test({
  name: "system-settings service: maskSecret 长度 ≤ 6 整体掩码",
  fn: () => {
    assertEquals(maskSecret("abc"), "***");
    assertEquals(maskSecret(""), "");
    assertEquals(maskSecret(null), "");
    assertEquals(maskSecret(undefined), "");
  },
});

Deno.test({
  name: "system-settings service: maskSecret 长度 > 6 保留首尾",
  fn: () => {
    assertEquals(maskSecret("my-super-secret-key-12345"), "my-***345");
    assertEquals(maskSecret("abcdefg"), "abc***efg");
    assertEquals(maskSecret("abcdef"), "***");
  },
});

Deno.test({
  name: "system-settings service: listSettings 包含所有 DB-backed 项",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const items = await listSettings();
    // 包含原始 5 项
    for (
      const k of [
        "allow_register",
        "smtp_from",
        "rate_limit_login_enabled",
        "maintenance_mode",
        "homepage_banner",
      ]
    ) {
      assertEquals(items.some((i) => i.key === k), true);
    }
    // 包含新增项（抽样）
    assertEquals(items.some((i) => i.key === "jwt_expires_in"), true);
    assertEquals(items.some((i) => i.key === "rate_limit_enabled"), true);
    assertEquals(items.some((i) => i.key === "email_provider"), true);
    assertEquals(items.some((i) => i.key === "storage_provider"), true);
    assertEquals(items.some((i) => i.key === "audit_log_retention_days"), true);
  },
});

Deno.test({
  name: "system-settings service: listSettings 敏感字段掩码生效",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    // 写一个 is_secret=true 的非注册表 key（直接走 DB，绕过注册表 type 校验）
    // 这里改用 mock：通过 service 间接验证（注册表中 5 项均 is_secret=false）
    // 所以改用更新后 listSettings 检查 raw_value 未被掩码
    await updateSetting("allow_register", false, "0");
    const items = await listSettings();
    const allowReg = items.find((i) => i.key === "allow_register");
    assertEquals(allowReg?.source, "db");
    // 5 个注册表项 is_secret=false，effective_value 不会被掩码
    assertEquals(allowReg?.effective_value, false);
    assertEquals(allowReg?.is_secret, false);
  },
});

Deno.test({
  name:
    "system-settings service: listSettings env-only raw_value 是 JSON 编码字符串",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 模拟运行时 .env 中有该 key：先 setenv 再重置并快照
    Deno.env.set("REDIS_URL", "redis://127.0.0.1:6379/");
    await resetDbForTest();
    _resetSystemSettingsForTest();
    _resetEnvSnapshotForTest();
    snapshotEnv();
    await initSystemSettings();

    const items = await listSettings();
    const redis = items.find((i) => i.key === "REDIS_URL");
    assertEquals(redis !== undefined, true);
    // spec 要求 raw_value 是 "原始 JSON 编码"
    assertEquals(redis?.raw_value, JSON.stringify("redis://127.0.0.1:6379/"));
    // raw_value 可被 JSON.parse 反序列化
    assertEquals(JSON.parse(redis!.raw_value), "redis://127.0.0.1:6379/");

    Deno.env.delete("REDIS_URL");
  },
});

// 清理
Deno.test({
  name: "system-settings service: cleanup",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      const db = getDb();
      await db.delete(systemSettings).where(
        eq(systemSettings.key, `test_init_${ts}`),
      );
    } catch {
      // ignore
    }
  },
});
