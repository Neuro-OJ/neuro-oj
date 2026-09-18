import { assertEquals } from "@std/assert";
import {
  ENV_KEYS,
  isPlaceholder,
  JUDGE_KEYS,
  validateEnv,
} from "./config-schema.ts";

/**
 * 键清单的权威来源是 bash `scripts/deploy/deploy.sh:686-692` 的 `check_required_values`。
 */
const BASH_REQUIRED_KEYS = [
  "NOJ_VERSION",
  "DOMAIN",
  "APP_URL",
  "CORS_ALLOWED_ORIGINS",
  "TRUSTED_PROXIES",
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_BUCKET",
  "S3_ENDPOINT",
  "STORAGE_PROVIDER",
  "JWT_SECRET",
  "TFA_ENCRYPTION_KEY",
  "NOJ_LLM_SERVICE_TOKEN",
  "NOJ_LLM_STORE_KEY",
  "EMAIL_PROVIDER",
] as const;

Deno.test("ENV_KEYS 覆盖 bash 硬编码的 19 个键", () => {
  const names = ENV_KEYS.map((k) => k.key);
  for (
    const k of [
      "NOJ_VERSION",
      "DOMAIN",
      "APP_URL",
      "CORS_ALLOWED_ORIGINS",
      "TRUSTED_PROXIES",
      "POSTGRES_PASSWORD",
      "REDIS_PASSWORD",
      "MINIO_ROOT_USER",
      "MINIO_ROOT_PASSWORD",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
      "S3_BUCKET",
      "S3_ENDPOINT",
      "STORAGE_PROVIDER",
      "JWT_SECRET",
      "TFA_ENCRYPTION_KEY",
      "NOJ_LLM_SERVICE_TOKEN",
      "NOJ_LLM_STORE_KEY",
      "EMAIL_PROVIDER",
    ]
  ) {
    assertEquals(names.includes(k), true, "缺少键: " + k);
  }
});

Deno.test("ENV_KEYS 与 bash 清单逐字一致（无多无少、无重复）", () => {
  const names = ENV_KEYS.map((k) => k.key);
  assertEquals([...names].sort(), [...BASH_REQUIRED_KEYS].sort());
  assertEquals(new Set(names).size, names.length, "ENV_KEYS 存在重复键");
  assertEquals(ENV_KEYS.length, 19);
  // judge 条件键不在无条件必需清单中
  for (const k of JUDGE_KEYS) {
    assertEquals(
      names.includes(k),
      false,
      "judge 条件键不应出现在 ENV_KEYS: " + k,
    );
  }
});

Deno.test("ENV_KEYS 全部标记 required 且敏感键带 secret", () => {
  for (const spec of ENV_KEYS) {
    assertEquals(spec.required, true, spec.key + " 应为必需");
  }
  const secretKeys = ENV_KEYS.filter((s) => s.secret).map((s) => s.key);
  for (
    const k of [
      "POSTGRES_PASSWORD",
      "REDIS_PASSWORD",
      "MINIO_ROOT_PASSWORD",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
      "JWT_SECRET",
      "TFA_ENCRYPTION_KEY",
      "NOJ_LLM_SERVICE_TOKEN",
      "NOJ_LLM_STORE_KEY",
    ]
  ) {
    assertEquals(secretKeys.includes(k), true, "缺少 secret 标记: " + k);
  }
  for (const k of ["DOMAIN", "APP_URL", "EMAIL_PROVIDER"]) {
    assertEquals(
      secretKeys.includes(k),
      false,
      "非敏感键不应标记 secret: " + k,
    );
  }
});

Deno.test("isPlaceholder 识别空值与占位值", () => {
  assertEquals(isPlaceholder(undefined), true);
  assertEquals(isPlaceholder(""), true);
  assertEquals(isPlaceholder("change-this-in-production"), true);
  assertEquals(isPlaceholder("your-domain.example.com"), true);
  // bash `is_placeholder` 的 `*example*` 是子串匹配，`real.example.com` 命中；
  // 这与 brief 提供的断言相反，以 bash（本任务权威来源）为准，详情见 task-2-report.md。
  assertEquals(isPlaceholder("real.example.com"), true);
});

Deno.test("isPlaceholder 逐字对照 bash is_placeholder 的 case 模式", () => {
  // 子串模式（deploy.sh:671）
  for (
    const v of [
      "change-me",
      "x-change-me-x",
      "prefix-change-this",
      "changeme",
      "foo-example-bar",
      "placeholder-x",
      "my-placeholder",
      "replace-me-now",
      "your-key",
      "your-domain.example.com",
    ]
  ) {
    assertEquals(isPlaceholder(v), true, "应判为占位值: " + v);
  }
  // 整体匹配 test / xxx*；不区分大小写不存在（bash case 区分大小写）
  assertEquals(isPlaceholder("test"), true);
  assertEquals(isPlaceholder("testing"), false);
  assertEquals(isPlaceholder("TEST"), false);
  assertEquals(isPlaceholder("Testing"), false);
  assertEquals(isPlaceholder("xxx"), true);
  assertEquals(isPlaceholder("xxxval"), true);
  assertEquals(isPlaceholder("vxx"), false);
  // 合法生产值不应误判
  for (
    const v of [
      "oj.neuro-oj.com",
      "https://noj.neuro-oj.com",
      "172.28.0.0/16",
      "s3",
      "disabled",
    ]
  ) {
    assertEquals(isPlaceholder(v), false, "不应判为占位值: " + v);
  }
});

Deno.test("validateEnv 报告缺失与占位", () => {
  const r = validateEnv({ DOMAIN: "", APP_URL: "https://real.example.com" });
  assertEquals(r.missing.includes("DOMAIN"), true);
  assertEquals(r.missing.includes("APP_URL"), false);
});

Deno.test("validateEnv 区分 missing 与 placeholder，且判定基于 bash is_placeholder", () => {
  const env: Record<string, string> = {};
  for (const k of BASH_REQUIRED_KEYS) env[k] = "real-value";
  env["DOMAIN"] = "";
  env["JWT_SECRET"] = "change-me-please";
  env["JUDGE_ENABLED"] = "false";
  const r = validateEnv(env);
  assertEquals(r.missing, ["DOMAIN"]);
  assertEquals(r.placeholder, ["JWT_SECRET"]);
  // JUDGE_ENABLED=false → 不要求 judge 键
  assertEquals(r.missing.includes("JUDGE_DOCKER_SOCKET"), false);
});

Deno.test("validateEnv 无缺失无占位时返回空集合", () => {
  const env: Record<string, string> = {};
  for (const k of BASH_REQUIRED_KEYS) env[k] = "real-value";
  env["JUDGE_ENABLED"] = "false";
  const r = validateEnv(env);
  assertEquals(r.missing, []);
  assertEquals(r.placeholder, []);
});

Deno.test("judge 启用时额外要求 JUDGE_DOCKER_SOCKET 与 GID", () => {
  const r = validateEnv({ JUDGE_ENABLED: "true" });
  assertEquals(r.missing.includes("JUDGE_DOCKER_SOCKET"), true);
  assertEquals(r.missing.includes("JUDGE_DOCKER_SOCKET_GID"), true);
});

Deno.test("judge 真值集合与 bash judge_enabled 一致", () => {
  // 真：空串（未设置）/ true / TRUE / yes / YES / 1 / on / ON
  for (const v of ["", "true", "TRUE", "yes", "YES", "1", "on", "ON"]) {
    const r = validateEnv({ JUDGE_ENABLED: v });
    assertEquals(
      r.missing.includes("JUDGE_DOCKER_SOCKET"),
      true,
      "JUDGE_ENABLED=" + JSON.stringify(v) + " 应视为启用",
    );
  }
  // 假：false / FALSE / no / NO / 0 / off / OFF
  for (const v of ["false", "FALSE", "no", "NO", "0", "off", "OFF"]) {
    const r = validateEnv({ JUDGE_ENABLED: v });
    assertEquals(
      r.missing.includes("JUDGE_DOCKER_SOCKET"),
      false,
      "JUDGE_ENABLED=" + JSON.stringify(v) + " 应视为关闭",
    );
  }
});

Deno.test("judge 启用时已配置的 judge 键不再报告缺失", () => {
  const env: Record<string, string> = {};
  for (const k of BASH_REQUIRED_KEYS) env[k] = "real-value";
  env["JUDGE_ENABLED"] = "true";
  env["JUDGE_DOCKER_SOCKET"] = "/run/noj-judge/docker.sock";
  env["JUDGE_DOCKER_SOCKET_GID"] = "10001";
  const r = validateEnv(env);
  assertEquals(r.missing, []);
  assertEquals(r.placeholder, []);
});
