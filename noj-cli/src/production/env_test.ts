import { assertEquals } from "@std/assert";
import {
  loadProdEnv,
  saveProdEnv,
  setProdEnv,
  showProdEnv,
  validateProdEnv,
} from "./env.ts";

function fullEnv(): Record<string, string> {
  return {
    NOJ_VERSION: "v0.1.0",
    APP_URL: "https://oj.neuro-oj.dev",
    DOMAIN: "oj.neuro-oj.dev",
    CORS_ALLOWED_ORIGINS: "https://oj.neuro-oj.dev",
    TRUSTED_PROXIES: "172.28.0.0/16",
    POSTGRES_USER: "noj",
    POSTGRES_DB: "noj",
    POSTGRES_PASSWORD: "strong",
    REDIS_PASSWORD: "strong",
    MINIO_ROOT_USER: "root",
    MINIO_ROOT_PASSWORD: "strong",
    S3_ACCESS_KEY: "key",
    S3_SECRET_KEY: "secret",
    S3_BUCKET: "bucket",
    JWT_SECRET: "strong-secret-with-32-chars-min-1234",
    TFA_ENCRYPTION_KEY: "strong-tfa-key-with-32-chars-min-1234",
    NOJ_LLM_SERVICE_TOKEN: "token",
    NOJ_LLM_STORE_KEY: "store",
    ADMIN_EMAIL: "admin@noj.test",
    ADMIN_PASS: "StrongPass123",
  };
}

Deno.test("loadProdEnv/saveProdEnv/setProdEnv", () => {
  const file = `${Deno.makeTempDirSync()}/.env.prod`;
  saveProdEnv(file, fullEnv());
  const loaded = loadProdEnv(file);
  assertEquals(loaded["NOJ_VERSION"], "v0.1.0");
  setProdEnv(file, "DOMAIN", "new.example.com");
  assertEquals(loadProdEnv(file)["DOMAIN"], "new.example.com");
});

Deno.test("validateProdEnv: 完整配置通过", () => {
  const file = `${Deno.makeTempDirSync()}/.env.prod`;
  saveProdEnv(file, fullEnv());
  assertEquals(validateProdEnv(file), []);
});

Deno.test("validateProdEnv: 缺失/占位/坏版本", () => {
  const file = `${Deno.makeTempDirSync()}/.env.prod`;
  const values = fullEnv();
  values["POSTGRES_PASSWORD"] = "change-me";
  values["NOJ_VERSION"] = "latest";
  saveProdEnv(file, values);
  const problems = validateProdEnv(file);
  assertEquals(problems.length > 0, true);
});

Deno.test("showProdEnv: 敏感字段脱敏", () => {
  const file = `${Deno.makeTempDirSync()}/.env.prod`;
  saveProdEnv(file, fullEnv());
  const shown = showProdEnv(file);
  assertEquals(shown.includes("POSTGRES_PASSWORD=***"), true);
  assertEquals(shown.includes("strong"), false);
});
