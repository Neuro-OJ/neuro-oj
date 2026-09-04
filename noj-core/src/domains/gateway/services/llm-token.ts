/**
 * LLM eval_token 签发工具（与 noj-llm-gateway 共享 NOJ_LLM_SERVICE_TOKEN）。
 */
import type { LlmConfig } from "./../../catalog/index.ts";
import type { JudgeTaskLlm } from "../../submission/index.ts";
import type { RuntimeConfig } from "../../catalog/index.ts";
import { encodeBase64 } from "@std/encoding/base64";

const IV_LENGTH = 12;

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

interface EvalTokenPayload {
  jti: string;
  submission_id: string;
  problem_id: string;
  user_id: string;
  provider_id: string;
  allowed_models: string[];
  iat: number;
  exp: number;
  max_calls: number;
  max_tokens: number;
}

/** 使用 NOJ_LLM_SERVICE_TOKEN 签发 AEAD eval_token（base64url）。 */
export async function mintEvalToken(
  payload: EvalTokenPayload,
): Promise<string> {
  const secret = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
  if (!secret || secret.length < 16) {
    throw new Error("NOJ_LLM_SERVICE_TOKEN 未配置或长度不足");
  }
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  const data = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  data.set(iv);
  data.set(new Uint8Array(ciphertext), IV_LENGTH);
  return encodeBase64(data);
}

/**
 * 为一次提交构造 JudgeTask.llm 字段。
 *
 * @param llmConfig 题目固定的 LLM 配置
 * @param submissionId 提交 ID
 * @param problemId 题目 ID
 * @param userId 提交用户 ID
 * @param runtimeConfig 题目 runtime_config（用于 TTL）
 */
export function buildJudgeTaskLlm(
  llmConfig: LlmConfig,
  submissionId: string,
  problemId: string,
  userId: string,
  runtimeConfig: RuntimeConfig,
): Promise<JudgeTaskLlm> {
  return buildJudgeTaskLlmForProvider(
    llmConfig.provider_id,
    llmConfig.model,
    submissionId,
    problemId,
    userId,
    runtimeConfig,
  );
}

/** 为指定 Provider 构造短期 LLM token，平台题目和用户 BYOK 共用该契约。 */
export async function buildJudgeTaskLlmForProvider(
  providerId: string,
  model: string,
  submissionId: string,
  problemId: string,
  userId: string,
  runtimeConfig: RuntimeConfig,
): Promise<JudgeTaskLlm> {
  const gatewayUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL") ??
    "http://localhost:8001";
  const timeLimitMs = runtimeConfig.evaluator.time_limit_ms;
  const ttlSeconds = Math.max(60, Math.ceil((timeLimitMs * 4) / 1000));
  const now = Math.floor(Date.now() / 1000);
  const token = await mintEvalToken({
    jti: crypto.randomUUID(),
    submission_id: submissionId,
    problem_id: problemId,
    user_id: userId,
    provider_id: providerId,
    allowed_models: [model],
    iat: now,
    exp: now + ttlSeconds,
    max_calls: Number(Deno.env.get("NOJ_LLM_MAX_CALLS") ?? "100"),
    max_tokens: Number(Deno.env.get("NOJ_LLM_MAX_TOKENS") ?? "50000"),
  });
  return {
    gateway_url: gatewayUrl,
    eval_token: token,
    provider_id: providerId,
    allowed_models: [model],
  };
}
