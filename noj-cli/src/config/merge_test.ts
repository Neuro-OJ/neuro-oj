import { assertEquals, assertThrows } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "./types.ts";
import { resolveComponentEnv } from "./merge.ts";
import { SCHEMA_VERSION } from "./types.ts";

const config: DeployConfig = {
  schema_version: SCHEMA_VERSION,
  type: "prod",
  state: "stopped",
  created_at: "2026-08-31T00:00:00Z",
  updated_at: "2026-08-31T00:00:00Z",
  install_dir: "/opt/neuro-oj",
  version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
  env: { "LOG_LEVEL": "info", "PORT": "8000" },
  components: {
    server: {
      enabled: true,
      method: "docker",
      env: {
        "PORT": "9000",
        "DATABASE_URL":
          "postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres/${POSTGRES_DB}",
        "JWT_SECRET": "${JWT_SECRET}",
      },
    },
  },
  reverse_proxy: {
    type: "nginx",
    config_dir: "/etc/nginx/conf.d",
    domain: "oj.example.com",
    upstream_port: 8080,
  },
};

const secrets: SecretsConfig = {
  schema_version: SCHEMA_VERSION,
  created_at: "2026-08-31T00:00:00Z",
  updated_at: "2026-08-31T00:00:00Z",
  secrets: {
    "POSTGRES_USER": "noj",
    "POSTGRES_PASSWORD": "pw",
    "POSTGRES_DB": "nojdb",
    "JWT_SECRET": "x".repeat(32),
  },
};

Deno.test("组件 env 覆盖全局 env", () => {
  const env = resolveComponentEnv(config, secrets, "server");
  assertEquals(env["PORT"], "9000"); // 组件覆盖全局
  assertEquals(env["LOG_LEVEL"], "info"); // 全局保留
});

Deno.test("占位符从 secrets 解析", () => {
  const env = resolveComponentEnv(config, secrets, "server");
  assertEquals(env["DATABASE_URL"], "postgres://noj:pw@postgres/nojdb");
  assertEquals(env["JWT_SECRET"], "x".repeat(32));
});

Deno.test("未知组件抛错", () => {
  assertThrows(
    () => resolveComponentEnv(config, secrets, "nonexistent"),
    Error,
    "组件 nonexistent 不存在",
  );
});
