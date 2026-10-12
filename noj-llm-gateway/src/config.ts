/**
 * noj-llm-gateway 环境配置。
 *
 * 新增密钥：
 * - NOJ_LLM_SERVICE_TOKEN：AEAD eval_token 签发/校验 + core↔gateway 管理 API 鉴权
 * - NOJ_LLM_STORE_KEY：加密存储上游 Provider API Key 的信封加密主密钥
 */

import { parseAllowedHosts } from "./upstream-guard.ts";

export interface GatewayConfig {
  port: number;
  /** 用户每个 UTC 分钟窗口允许的调用次数 */
  userRateLimitPerMinute: number;
  /** IP 每个 UTC 分钟窗口允许的调用次数 */
  ipRateLimitPerMinute: number;
  /** core↔gateway 管理 API 服务间鉴权，同时用于 AEAD eval_token 签发/校验 */
  serviceToken: string;
  /** 信封加密主密钥，用于加密/解密 llm_providers.encrypted_api_key */
  storeKey: string;
  databaseUrl: string;
  redisUrl: string;
  /** llm_usage 保留天数（0 = 不清理），默认 90 */
  usageRetentionDays: number;
  /** 允许 http / 内网地址的上游主机白名单（小写；内网自建模型与 E2E mock 用） */
  upstreamAllowedHosts: Set<string>;
}

export function loadConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): GatewayConfig {
  const port = Number(env.NOJ_LLM_PORT ?? env.PORT ?? "8001");
  const userRateLimitPerMinute = parsePositiveInteger(
    env.NOJ_LLM_USER_RATE_LIMIT_PER_MINUTE,
    "NOJ_LLM_USER_RATE_LIMIT_PER_MINUTE",
  );
  const ipRateLimitPerMinute = parsePositiveInteger(
    env.NOJ_LLM_IP_RATE_LIMIT_PER_MINUTE,
    "NOJ_LLM_IP_RATE_LIMIT_PER_MINUTE",
  );
  const usageRetentionDays = parseNonNegativeInteger(
    env.NOJ_LLM_USAGE_RETENTION_DAYS,
    "NOJ_LLM_USAGE_RETENTION_DAYS",
    90,
  );
  const upstreamAllowedHosts = parseAllowedHosts(
    env.NOJ_LLM_UPSTREAM_ALLOWED_HOSTS,
  );
  const serviceToken = env.NOJ_LLM_SERVICE_TOKEN ?? "";
  const storeKey = env.NOJ_LLM_STORE_KEY ?? "";
  const databaseUrl = env.DATABASE_URL ?? "";
  const redisUrl = env.REDIS_URL ?? "redis://127.0.0.1:6379/";

  if (!serviceToken || serviceToken.length < 16) {
    throw new Error("NOJ_LLM_SERVICE_TOKEN 未设置或长度不足（至少 16 字符）");
  }
  if (!storeKey || storeKey.length < 16) {
    throw new Error("NOJ_LLM_STORE_KEY 未设置或长度不足（至少 16 字符）");
  }
  if (!databaseUrl) {
    throw new Error("DATABASE_URL 未设置，noj-llm-gateway 无法启动");
  }
  if (!redisUrl) {
    throw new Error("REDIS_URL 未设置，noj-llm-gateway 无法启动");
  }

  return {
    port,
    userRateLimitPerMinute,
    ipRateLimitPerMinute,
    serviceToken,
    storeKey,
    databaseUrl,
    redisUrl,
    usageRetentionDays,
    upstreamAllowedHosts,
  };
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
): number {
  if (value === undefined) return 60;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} 必须是正整数`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return parsed;
}

function parseNonNegativeInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} 必须是非负整数`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} 必须是非负整数`);
  }
  return parsed;
}
