import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { loadConfig } from "../src/config.ts";

const baseEnv = {
  NOJ_LLM_SERVICE_TOKEN: "test-service-token-0123456789",
  NOJ_LLM_STORE_KEY: "test-store-key-0123456789",
  DATABASE_URL: "postgres://localhost/noj",
  REDIS_URL: "redis://localhost:6379/0",
};

Deno.test("config: minute rate limits default to 60", () => {
  const config = loadConfig(baseEnv);
  assertEquals(config.userRateLimitPerMinute, 60);
  assertEquals(config.ipRateLimitPerMinute, 60);
});

Deno.test("config: user and IP minute rate limits are independent", () => {
  const config = loadConfig({
    ...baseEnv,
    NOJ_LLM_USER_RATE_LIMIT_PER_MINUTE: "120",
    NOJ_LLM_IP_RATE_LIMIT_PER_MINUTE: "30",
  });
  assertEquals(config.userRateLimitPerMinute, 120);
  assertEquals(config.ipRateLimitPerMinute, 30);
});

for (
  const name of [
    "NOJ_LLM_USER_RATE_LIMIT_PER_MINUTE",
    "NOJ_LLM_IP_RATE_LIMIT_PER_MINUTE",
  ]
) {
  for (const value of ["", "0", "-1", "1.5", "abc", " 60"]) {
    Deno.test(`config: rejects invalid ${name}=${JSON.stringify(value)}`, () => {
      assertThrows(
        () => loadConfig({ ...baseEnv, [name]: value }),
        Error,
        name,
      );
    });
  }
}

Deno.test("config: 缺少 SERVICE_TOKEN 时拒绝启动", () => {
  assertThrows(
    () => loadConfig({ ...baseEnv, NOJ_LLM_SERVICE_TOKEN: "" }),
    Error,
    "NOJ_LLM_SERVICE_TOKEN",
  );
});

Deno.test("config: SERVICE_TOKEN 长度不足 16 时拒绝启动", () => {
  assertThrows(
    () => loadConfig({ ...baseEnv, NOJ_LLM_SERVICE_TOKEN: "short" }),
    Error,
    "NOJ_LLM_SERVICE_TOKEN",
  );
});

Deno.test("config: 缺少 STORE_KEY 时拒绝启动", () => {
  assertThrows(
    () => loadConfig({ ...baseEnv, NOJ_LLM_STORE_KEY: "" }),
    Error,
    "NOJ_LLM_STORE_KEY",
  );
});

Deno.test("config: STORE_KEY 长度不足 16 时拒绝启动", () => {
  assertThrows(
    () => loadConfig({ ...baseEnv, NOJ_LLM_STORE_KEY: "short" }),
    Error,
    "NOJ_LLM_STORE_KEY",
  );
});

Deno.test("config: 缺少 DATABASE_URL 时拒绝启动", () => {
  assertThrows(
    () => loadConfig({ ...baseEnv, DATABASE_URL: "" }),
    Error,
    "DATABASE_URL",
  );
});

Deno.test("config: REDIS_URL 为空时拒绝启动", () => {
  assertThrows(
    () => loadConfig({ ...baseEnv, REDIS_URL: "" }),
    Error,
    "REDIS_URL",
  );
});
