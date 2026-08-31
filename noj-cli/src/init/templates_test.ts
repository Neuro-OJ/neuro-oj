import { assertEquals } from "@std/assert";
import { devTemplate, prodTemplate } from "./templates.ts";
import { generateSecrets, randomKey } from "./secrets.ts";
import { SCHEMA_VERSION } from "../config/types.ts";

Deno.test("randomKey: 生成指定字节数的 hex 字符串", () => {
  const key = randomKey(32);
  assertEquals(key.length, 64);
  assertEquals(/^[0-9a-f]+$/.test(key), true);
});

Deno.test("generateSecrets: 核心密钥齐全且 JWT/TFA 长度 >= 32", () => {
  const secrets = generateSecrets("prod");
  assertEquals(secrets.schema_version, SCHEMA_VERSION);
  for (
    const k of [
      "POSTGRES_PASSWORD",
      "REDIS_PASSWORD",
      "MINIO_ROOT_USER",
      "MINIO_ROOT_PASSWORD",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
      "JWT_SECRET",
      "TFA_ENCRYPTION_KEY",
      "NOJ_LLM_SERVICE_TOKEN",
      "NOJ_LLM_STORE_KEY",
    ]
  ) {
    assertEquals(secrets.secrets[k] !== undefined, true, `缺少 ${k}`);
  }
  assertEquals(secrets.secrets["JWT_SECRET"]!.length >= 32, true);
  assertEquals(secrets.secrets["TFA_ENCRYPTION_KEY"]!.length >= 32, true);
});

Deno.test("devTemplate: dev 模式，server/ui 为 process，judge/nginx 禁用", () => {
  const cfg = devTemplate("/opt/neuro-oj", 8080);
  assertEquals(cfg.type, "dev");
  assertEquals(cfg.schema_version, SCHEMA_VERSION);
  assertEquals(cfg.components["server"]!.method, "process");
  assertEquals(cfg.components["ui"]!.method, "process");
  assertEquals(cfg.components["judge"]!.enabled, false);
  assertEquals(cfg.components["nginx"]!.enabled, false);
  assertEquals(cfg.components["postgres"]!.method, "docker");
});

Deno.test("prodTemplate: prod 模式，全部 docker，nginx 启用，judge 按选项", () => {
  const cfg = prodTemplate({
    installDir: "/opt/neuro-oj",
    domain: "oj.example.com",
    https: true,
    port: 8080,
    judgeEnabled: true,
    emailProvider: "disabled",
  });
  assertEquals(cfg.type, "prod");
  assertEquals(cfg.components["nginx"]!.enabled, true);
  assertEquals(cfg.components["judge"]!.enabled, true);
  assertEquals(cfg.components["server"]!.method, "docker");
  assertEquals(cfg.env["DOMAIN"], "oj.example.com");
  assertEquals(cfg.env["APP_URL"], "https://oj.example.com");
});
