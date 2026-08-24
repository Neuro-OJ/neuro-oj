import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  findProductionConfigErrors,
  type ProductionConfig,
} from "../../src/lib/production-config.ts";

function validConfig(): ProductionConfig {
  return {
    environment: "production",
    databaseUrl: "postgres://noj:prod-db-secret@postgres:5432/noj",
    redisUrl: "redis://:prod-redis-secret@redis:6379/0",
    jwtSecret: "j".repeat(32),
    tfaEncryptionKey: "t".repeat(32),
    adminEmail: "admin@noj.org",
    adminPassword: "prod-admin-password-2026",
    appUrl: "https://noj.org",
    corsAllowedOrigins: "https://noj.org",
    trustedProxies: "172.28.0.0/16",
    emailProvider: "aliyun",
    emailSettings: {
      alibaba_access_key_id: "aliyun-access-key",
      alibaba_access_key_secret: "aliyun-secret-key",
      alibaba_from_email: "noreply@noj.org",
    },
    storageProvider: "s3",
    s3Endpoint: "http://minio:9000",
    s3AccessKey: "noj-storage-user",
    s3SecretKey: "noj-storage-secret",
    s3Bucket: "noj-support-packages",
  };
}

Deno.test("production-config: 合法生产配置通过校验", () => {
  assertEquals(findProductionConfigErrors(validConfig()), []);
});

Deno.test("production-config: 开发和测试环境保留 mock/local 默认行为", () => {
  const config = validConfig();
  config.environment = "development";
  config.emailProvider = "mock";
  config.storageProvider = "local";
  config.jwtSecret = "weak";
  assertEquals(findProductionConfigErrors(config), []);
});

Deno.test("production-config: 拒绝 mock、local、占位符和不安全地址", () => {
  const config = validConfig();
  config.emailProvider = "mock";
  config.storageProvider = "local";
  config.jwtSecret = "change-me-to-a-random-string-at-least-32-chars";
  config.appUrl = "http://change-me.example.com";
  config.corsAllowedOrigins = "*";
  config.trustedProxies = "";

  const errors = findProductionConfigErrors(config).join("\n");
  assert(errors.includes("EMAIL_PROVIDER"));
  assert(errors.includes("STORAGE_PROVIDER"));
  assert(errors.includes("JWT_SECRET"));
  assert(errors.includes("APP_URL"));
  assert(errors.includes("CORS_ALLOWED_ORIGINS"));
  assert(errors.includes("TRUSTED_PROXIES"));
});

Deno.test("production-config: 缺少邮件和 S3 凭据时只报告配置键名", () => {
  const config = validConfig();
  const secret = "super-secret-value-must-not-appear";
  config.emailProvider = "tencent";
  config.emailSettings = { tencent_secret_key: secret };
  config.s3AccessKey = undefined;
  config.s3SecretKey = undefined;
  config.s3Endpoint = undefined;

  const errors = findProductionConfigErrors(config).join("\n");
  assert(errors.includes("TENCENT_SECRET_ID"));
  assert(errors.includes("S3_ACCESS_KEY"));
  assert(errors.includes("S3_SECRET_KEY"));
  assert(!errors.includes(secret));
});
