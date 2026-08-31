import { assertEquals } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "./types.ts";
import { validateConfig } from "./validate.ts";
import { SCHEMA_VERSION } from "./types.ts";

function baseConfig(): DeployConfig {
  return {
    schema_version: SCHEMA_VERSION,
    type: "prod",
    state: "stopped",
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {},
    components: {
      server: {
        enabled: true,
        method: "docker",
        env: { "JWT_SECRET": "${JWT_SECRET}" },
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
    schema_version: SCHEMA_VERSION,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    secrets: { "JWT_SECRET": "x".repeat(32) },
  };
}

Deno.test("合法配置无问题", () => {
  assertEquals(validateConfig(baseConfig(), baseSecrets()), []);
});

Deno.test("schema_version 错误时报告", () => {
  const cfg = baseConfig();
  cfg.schema_version = 2;
  const issues = validateConfig(cfg, baseSecrets());
  assertEquals(issues.some((i) => i.path === "schema_version"), true);
});

Deno.test("被引用 secret 缺失时报告", () => {
  const cfg = baseConfig();
  cfg.components["server"]!.env["TFA_ENCRYPTION_KEY"] = "${TFA_ENCRYPTION_KEY}";
  const issues = validateConfig(cfg, baseSecrets());
  assertEquals(issues.some((i) => i.path.includes("TFA_ENCRYPTION_KEY")), true);
});

Deno.test("secret 长度不足 32 时报告", () => {
  const secrets = baseSecrets();
  secrets.secrets["JWT_SECRET"] = "short";
  const issues = validateConfig(cfgForShort(), secrets);
  assertEquals(issues.some((i) => i.path.includes("JWT_SECRET")), true);

  function cfgForShort(): DeployConfig {
    const c = baseConfig();
    c.components["server"]!.env["JWT_SECRET"] = "${JWT_SECRET}";
    return c;
  }
});
