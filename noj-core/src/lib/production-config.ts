/**
 * 生产环境配置护栏。
 *
 * 该模块只负责校验配置并返回不含敏感值的错误信息，实际退出由启动入口负责。
 * 开发和测试环境不启用生产专用限制。
 */

import {
  MIN_JWT_SECRET_LENGTH,
  MIN_TFA_ENCRYPTION_KEY_LENGTH,
} from "./constants.ts";

export interface ProductionConfig {
  environment?: string;
  databaseUrl?: string;
  redisUrl?: string;
  jwtSecret?: string;
  tfaEncryptionKey?: string;
  adminEmail?: string;
  adminPassword?: string;
  appUrl?: string;
  corsAllowedOrigins?: string;
  trustedProxies?: string;
  emailProvider?: string;
  emailSettings: Record<string, string | undefined>;
  storageProvider?: string;
  s3Endpoint?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Bucket?: string;
}

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /change[-_ ]?this/i,
  /change[-_ ]?me/i,
  /changeme/i,
  /example(?:\.com)?/i,
  /placeholder/i,
  /replace[-_ ]?me/i,
  /your[-_ ]?(?:secret|password|key|domain)/i,
  /(^|[-_])test($|[-_])/i,
  /(^|[-_])xxx+($|[-_])/i,
];

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

function requireValue(
  findings: string[],
  key: string,
  value: string | undefined,
  options: { minLength?: number; rejectPlaceholder?: boolean } = {},
): void {
  if (!value || value.trim() === "") {
    findings.push(`${key} 未配置`);
    return;
  }
  if (options.rejectPlaceholder !== false && isPlaceholder(value)) {
    findings.push(`${key} 仍为模板占位符`);
  }
  if (options.minLength !== undefined && value.length < options.minLength) {
    findings.push(`${key} 长度不足 ${options.minLength} 字符`);
  }
}

function validateHttpsUrl(
  findings: string[],
  key: string,
  value: string | undefined,
): void {
  requireValue(findings, key, value);
  if (!value || isPlaceholder(value)) return;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      findings.push(`${key} 必须使用 HTTPS`);
    }
    if (url.username || url.password) {
      findings.push(`${key} 不得包含账号或密码`);
    }
  } catch {
    findings.push(`${key} 不是有效 URL`);
  }
}

function validateCorsOrigins(
  findings: string[],
  value: string | undefined,
): void {
  requireValue(findings, "CORS_ALLOWED_ORIGINS", value);
  if (!value || isPlaceholder(value)) return;

  const origins = value.split(",").map((origin) => origin.trim()).filter(
    Boolean,
  );
  if (origins.length === 0 || origins.includes("*")) {
    findings.push("CORS_ALLOWED_ORIGINS 不得为空或包含通配符 *");
    return;
  }
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (
        url.protocol !== "https:" || url.pathname !== "/" || url.search ||
        url.hash
      ) {
        findings.push(
          "CORS_ALLOWED_ORIGINS 中每个来源必须是无路径的 HTTPS origin",
        );
        return;
      }
    } catch {
      findings.push("CORS_ALLOWED_ORIGINS 包含无效 origin");
      return;
    }
  }
}

function validateEmail(
  findings: string[],
  provider: string | undefined,
  settings: Record<string, string | undefined>,
): void {
  if (provider !== "aliyun" && provider !== "tencent") {
    findings.push("EMAIL_PROVIDER 必须配置为 aliyun 或 tencent");
    return;
  }

  const required = provider === "aliyun"
    ? [
      ["ALIBABA_ACCESS_KEY_ID", "alibaba_access_key_id"],
      ["ALIBABA_ACCESS_KEY_SECRET", "alibaba_access_key_secret"],
      ["ALIBABA_FROM_EMAIL", "alibaba_from_email"],
    ] as const
    : [
      ["TENCENT_SECRET_ID", "tencent_secret_id"],
      ["TENCENT_SECRET_KEY", "tencent_secret_key"],
      ["TENCENT_FROM_EMAIL", "tencent_from_email"],
      ["TENCENT_REGION", "tencent_region"],
    ] as const;

  for (const [envKey, settingKey] of required) {
    requireValue(findings, envKey, settings[settingKey]);
  }
}

export function findProductionConfigErrors(
  config: ProductionConfig,
): string[] {
  if (config.environment !== "production") return [];

  const findings: string[] = [];
  requireValue(findings, "DATABASE_URL", config.databaseUrl);
  requireValue(findings, "REDIS_URL", config.redisUrl);
  requireValue(findings, "JWT_SECRET", config.jwtSecret, {
    minLength: MIN_JWT_SECRET_LENGTH,
  });
  requireValue(findings, "TFA_ENCRYPTION_KEY", config.tfaEncryptionKey, {
    minLength: MIN_TFA_ENCRYPTION_KEY_LENGTH,
  });
  requireValue(findings, "ADMIN_EMAIL", config.adminEmail);
  requireValue(findings, "ADMIN_PASS", config.adminPassword, {
    minLength: 12,
  });
  validateHttpsUrl(findings, "APP_URL", config.appUrl);
  validateCorsOrigins(findings, config.corsAllowedOrigins);
  requireValue(findings, "TRUSTED_PROXIES", config.trustedProxies);

  validateEmail(findings, config.emailProvider, config.emailSettings);

  if (config.storageProvider !== "s3") {
    findings.push("STORAGE_PROVIDER 在生产环境必须配置为 s3");
  }
  requireValue(findings, "S3_ENDPOINT", config.s3Endpoint);
  requireValue(findings, "S3_ACCESS_KEY", config.s3AccessKey);
  requireValue(findings, "S3_SECRET_KEY", config.s3SecretKey);
  requireValue(findings, "S3_BUCKET", config.s3Bucket);

  return findings;
}

export function assertProductionConfig(config: ProductionConfig): void {
  const findings = findProductionConfigErrors(config);
  if (findings.length > 0) {
    throw new Error(
      `生产配置校验失败（${findings.length} 项）：\n- ${findings.join("\n- ")}`,
    );
  }
}
