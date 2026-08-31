import { assertEquals } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import { COMPOSE_FILE, ensureComposeFile, renderCompose } from "./compose.ts";

const NOW = "2026-08-31T00:00:00Z";

function baseConfig(): DeployConfig {
  return {
    schema_version: 1,
    type: "dev",
    state: "stopped",
    created_at: NOW,
    updated_at: NOW,
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: { LOG_LEVEL: "info" },
    components: {
      postgres: {
        enabled: true,
        method: "docker",
        image: "postgres:16-alpine",
        internal_port: 5432,
        host_port: null,
        env: {
          POSTGRES_USER: "noj",
          POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}",
        },
      },
      redis: {
        enabled: true,
        method: "docker",
        image: "redis:7-alpine",
        internal_port: 6379,
        host_port: null,
        env: {},
      },
      nginx: {
        enabled: true,
        method: "docker",
        image: "nginx:1.27-alpine",
        port: 8080,
        host_port: 8080,
        env: {},
      },
      server: {
        enabled: true,
        method: "process",
        binary: "noj-server",
        port: 8000,
        host_port: null,
        env: { PORT: "8000", JWT_SECRET: "${JWT_SECRET}" },
      },
    },
    reverse_proxy: {
      type: "nginx",
      config_dir: "/etc/nginx/conf.d",
      domain: "oj.example.com",
      upstream_port: 8080,
    },
  };
}

function baseSecrets(): SecretsConfig {
  return {
    schema_version: 1,
    created_at: NOW,
    updated_at: NOW,
    secrets: { POSTGRES_PASSWORD: "pg-secret" },
  };
}

Deno.test("renderCompose: 只渲染 enabled 且 method=docker 的组件", () => {
  const yaml = renderCompose(baseConfig(), baseSecrets());
  assertEquals(yaml.includes("postgres:"), true);
  assertEquals(yaml.includes("redis:"), true);
  assertEquals(yaml.includes("nginx:"), true);
  // server 是 process，不应出现在 compose 里
  assertEquals(yaml.includes("server:"), false);
});

Deno.test("renderCompose: environment 为解析后的最终 env（含 secret）", () => {
  const yaml = renderCompose(baseConfig(), baseSecrets());
  assertEquals(yaml.includes(`POSTGRES_PASSWORD: "pg-secret"`), true);
});

Deno.test("renderCompose: host_port 生成 ports，基础设施挂卷", () => {
  const yaml = renderCompose(baseConfig(), baseSecrets());
  assertEquals(yaml.includes(`"8080:8080"`), true);
  assertEquals(yaml.includes("postgres-data:/var/lib/postgresql/data"), true);
  assertEquals(yaml.includes("redis-data:/data"), true);
});

Deno.test("renderCompose: 顶层 volumes 声明", () => {
  const yaml = renderCompose(baseConfig(), baseSecrets());
  assertEquals(yaml.includes("volumes:"), true);
  assertEquals(yaml.includes("postgres-data:"), true);
});

Deno.test("ensureComposeFile: 生成 compose 文件并复用现文件", async () => {
  const dir = await Deno.makeTempDir();
  const config = baseConfig();
  const secrets = baseSecrets();
  const p1 = await ensureComposeFile(dir, config, secrets);
  assertEquals(p1, `${dir}/${COMPOSE_FILE}`);
  const first = await Deno.readTextFile(p1);
  // 再次调用，内容相同应复用（mtime 不变），仍返回同一路径
  const p2 = await ensureComposeFile(dir, config, secrets);
  assertEquals(p2, p1);
  const second = await Deno.readTextFile(p2);
  assertEquals(second, first);
});
