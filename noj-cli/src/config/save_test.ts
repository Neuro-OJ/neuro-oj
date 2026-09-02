import { makeTempDir } from "../testing/helpers.ts";
import { assertEquals } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "./types.ts";
import { saveDeployment } from "./save.ts";
import { DEPLOY_FILE_MODE, SECRETS_FILE_MODE } from "./io.ts";

const config: DeployConfig = {
  schema_version: 1,
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

const secrets: SecretsConfig = {
  schema_version: 1,
  created_at: "2026-08-31T00:00:00Z",
  updated_at: "2026-08-31T00:00:00Z",
  secrets: { "POSTGRES_PASSWORD": "secret" },
};

Deno.test("saveDeployment 写出两个文件并设置权限", async () => {
  const dir = await makeTempDir();
  await saveDeployment(dir, config, secrets);

  const deployStat = await Deno.stat(`${dir}/noj-deploy.json`);
  const secretsStat = await Deno.stat(`${dir}/noj-secrets.json`);
  assertEquals(deployStat.mode! & 0o777, DEPLOY_FILE_MODE);
  assertEquals(secretsStat.mode! & 0o777, SECRETS_FILE_MODE);

  const written = JSON.parse(
    await Deno.readTextFile(`${dir}/noj-deploy.json`),
  ) as DeployConfig;
  assertEquals(written.type, "prod");
  const writtenSecrets = JSON.parse(
    await Deno.readTextFile(`${dir}/noj-secrets.json`),
  ) as SecretsConfig;
  assertEquals(writtenSecrets.secrets["POSTGRES_PASSWORD"], "secret");
});

Deno.test("saveDeployment 更新 updated_at 为 UTC ISO", async () => {
  const dir = await makeTempDir();
  const cfg = structuredClone(config);
  cfg.updated_at = "1970-01-01T00:00:00Z";
  await saveDeployment(dir, cfg, secrets);
  const written = JSON.parse(
    await Deno.readTextFile(`${dir}/noj-deploy.json`),
  ) as DeployConfig;
  assertEquals(new Date(written.updated_at).toISOString(), written.updated_at);
  assertEquals(written.updated_at.endsWith("Z"), true);
});
