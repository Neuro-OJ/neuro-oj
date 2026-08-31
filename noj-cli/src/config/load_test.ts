import { assertRejects } from "@std/assert";
import { assertEquals } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "./types.ts";
import { loadDeployment } from "./load.ts";
import { SCHEMA_VERSION } from "./types.ts";

function sampleConfig(): DeployConfig {
  return {
    schema_version: SCHEMA_VERSION,
    type: "prod",
    state: "stopped",
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {},
    components: {},
    reverse_proxy: {
      type: "nginx",
      config_dir: "/etc/nginx/conf.d",
      domain: "oj.example.com",
      upstream_port: 8080,
    },
  };
}

function sampleSecrets(): SecretsConfig {
  return {
    schema_version: SCHEMA_VERSION,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    secrets: { "POSTGRES_PASSWORD": "secret" },
  };
}

Deno.test("loadDeployment 在文件缺失时抛错", async () => {
  const dir = await Deno.makeTempDir();
  await assertRejects(() => loadDeployment(dir), Error, "noj-deploy.json");
});

Deno.test("loadDeployment 读取两个 JSON 并解析类型", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/noj-deploy.json`,
    JSON.stringify(sampleConfig(), null, 2),
  );
  await Deno.writeTextFile(
    `${dir}/noj-secrets.json`,
    JSON.stringify(sampleSecrets(), null, 2),
  );
  const { config, secrets } = await loadDeployment(dir);
  assertEquals(config.schema_version, SCHEMA_VERSION);
  assertEquals(config.state, "stopped");
  assertEquals(secrets.secrets["POSTGRES_PASSWORD"], "secret");
});
