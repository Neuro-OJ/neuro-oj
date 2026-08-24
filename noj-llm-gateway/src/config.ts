/**
 * noj-llm-gateway 环境配置。
 *
 * 新增密钥：
 * - NOJ_LLM_SERVICE_TOKEN：AEAD eval_token 签发/校验 + core↔gateway 管理 API 鉴权
 * - NOJ_LLM_STORE_KEY：加密存储上游 Provider API Key 的信封加密主密钥
 */

export interface GatewayConfig {
  port: number;
  /** core↔gateway 管理 API 服务间鉴权，同时用于 AEAD eval_token 签发/校验 */
  serviceToken: string;
  /** 信封加密主密钥，用于加密/解密 llm_providers.encrypted_api_key */
  storeKey: string;
  databaseUrl: string;
  redisUrl: string;
}

export function loadConfig(env: Record<string, string | undefined> = Deno.env.toObject()): GatewayConfig {
  const port = Number(env.NOJ_LLM_PORT ?? env.PORT ?? "8001");
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

  return { port, serviceToken, storeKey, databaseUrl, redisUrl };
}
