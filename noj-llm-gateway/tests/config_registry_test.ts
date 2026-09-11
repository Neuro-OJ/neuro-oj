/**
 * 网关配置声明一致性测试（issue #497）。
 *
 * 背景：`NOJ_LLM_DEFAULT_*` 配额 env 由 `limits.ts` 的 `fallbackQuota()` 用
 * **模板字符串动态拼接**读取（`NOJ_LLM_DEFAULT_<SCOPE>_<WINDOW>_<FIELD>`），
 * 普通字面量搜索查不到。它们因此长期“隐身”：既登记在 noj-core 注册表里
 * （误导运维以为影响 core），又漏登记了实际支持的 month 窗口变体。
 *
 * 本测试把「声明集合」与「实际读取集合」钉死在一起：
 * `limits.ts` 一旦增删窗口/字段而忘记同步 `config-registry.ts`，这里立刻失败，
 * 而不是静默地让新键不可发现。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import {
  findQuotaEnvDrift,
  GATEWAY_CONFIG_DEFINITIONS,
  QUOTA_ENV_PREFIX,
  quotaEnvKeys,
} from "../src/config-registry.ts";
import { QUOTA_ENV_KEYS } from "../src/limits.ts";

Deno.test("config-registry: limits.ts 实际读取的配额 env 与声明完全一致", () => {
  // 同时钉住两侧集合本身，避免「两边同时为空」的假通过
  assertEquals(QUOTA_ENV_KEYS.length, 18);
  const drift = findQuotaEnvDrift();
  assertEquals(
    drift.missing,
    [],
    `以下配额 env 被 limits.ts 读取但未在声明中列出：${
      drift.missing.join(", ")
    }`,
  );
  assertEquals(
    drift.unexpected,
    [],
    `以下配额 env 已声明但 limits.ts 不会读取：${drift.unexpected.join(", ")}`,
  );
});

Deno.test("config-registry: 配额键覆盖 3 scope × 2 window × 3 field = 18 个", () => {
  const keys = quotaEnvKeys();
  assertEquals(keys.length, 18);
  // day 与 month 窗口都必须在内（month 变体曾是漏登记的部分）
  assertEquals(keys.filter((k) => k.includes("_DAY_")).length, 9);
  assertEquals(keys.filter((k) => k.includes("_MONTH_")).length, 9);
  // 键名形状与 limits.ts 的模板拼接逐字一致
  for (const key of keys) {
    assertEquals(key.startsWith(QUOTA_ENV_PREFIX), true);
  }
  assertEquals(
    keys.includes("NOJ_LLM_DEFAULT_PROBLEM_MONTH_COST"),
    true,
    "problem/month 的 cost 变体必须在声明中（历史漏登记项）",
  );
});

Deno.test("config-registry: 安全相关键被显式声明且标记敏感级别", () => {
  const byKey = new Map(GATEWAY_CONFIG_DEFINITIONS.map((d) => [d.key, d]));

  const byok = byKey.get("NOJ_LLM_BYOK_ALLOWED_HOSTS");
  assertEquals(
    byok !== undefined,
    true,
    "BYOK 出网白名单必须登记（issue #499：安全相关且此前完全未登记）",
  );
  assertEquals(byok?.defaultValue, "api.openai.com");

  // 密钥类必须标 isSecret，避免在文档/后台明文展示
  for (
    const key of ["NOJ_LLM_SERVICE_TOKEN", "NOJ_LLM_STORE_KEY", "DATABASE_URL"]
  ) {
    assertEquals(byKey.get(key)?.isSecret, true, `${key} 应标为敏感`);
  }
});

Deno.test("config-registry: 声明键名唯一（避免重复登记互相覆盖）", () => {
  const keys = GATEWAY_CONFIG_DEFINITIONS.map((d) => d.key);
  assertEquals(new Set(keys).size, keys.length);
});
