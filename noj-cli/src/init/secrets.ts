import type { SecretsConfig } from "../config/types.ts";
import { SCHEMA_VERSION } from "../config/types.ts";

/** 生成 bytes 字节的随机 hex 字符串（长度 bytes*2）。 */
export function randomKey(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 生成部署所需核心密钥；JWT/TFA 用 32 字节（64 hex）满足长度校验。 */
export function generateSecrets(mode: "dev" | "prod"): SecretsConfig {
  const now = new Date().toISOString();
  const secrets: Record<string, string> = {
    POSTGRES_PASSWORD: randomKey(16),
    REDIS_PASSWORD: randomKey(16),
    MINIO_ROOT_USER: "minioadmin",
    MINIO_ROOT_PASSWORD: randomKey(16),
    S3_ACCESS_KEY: randomKey(16),
    S3_SECRET_KEY: randomKey(32),
    JWT_SECRET: randomKey(32),
    TFA_ENCRYPTION_KEY: randomKey(32),
    NOJ_LLM_SERVICE_TOKEN: randomKey(32),
    NOJ_LLM_STORE_KEY: randomKey(32),
  };
  if (mode === "prod") {
    // 可选云厂商/OAuth 密钥留空，用户后续自行填写。
    secrets["ALIBABA_ACCESS_KEY_ID"] = "";
    secrets["ALIBABA_ACCESS_KEY_SECRET"] = "";
    secrets["TENCENT_SECRET_ID"] = "";
    secrets["TENCENT_SECRET_KEY"] = "";
    secrets["OAUTH_GITHUB_CLIENT_ID"] = "";
    secrets["OAUTH_GITHUB_CLIENT_SECRET"] = "";
    secrets["OAUTH_OIDC_CLIENT_ID"] = "";
    secrets["OAUTH_OIDC_CLIENT_SECRET"] = "";
  }
  return {
    schema_version: SCHEMA_VERSION,
    created_at: now,
    updated_at: now,
    secrets,
  };
}
