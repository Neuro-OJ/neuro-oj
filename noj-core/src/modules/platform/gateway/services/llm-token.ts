/**
 * LLM eval_token 签发工具（与 noj-llm-gateway 共享 NOJ_LLM_SERVICE_TOKEN）。
 */
import type { LlmConfig } from "../../../problems/types/problems.ts";
import type { JudgeTaskLlm } from "../../../evaluations/types/index.ts";
import type { RuntimeConfig } from "../../../problems/types/runtime-config.ts";
import { encodeBase64 } from "@std/encoding/base64";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import {
  type GatewayResolvedModelSelection,
  getLlmProviderById,
  LlmGatewayError,
  resolveLlmGatewayExecution,
} from "./llm.ts";
import { resolveLlmLimits } from "./llm-limits.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { isDefaultOnly, normalizeLlmModels } from "./llm-model-aliases.ts";
import { LLM_DEFAULT_MODEL_ALIAS } from "../../../problems/types/problems.ts";

const IV_LENGTH = 12;

/** 一次尝试已解析的 LLM 执行配置；重新派发只续签凭据，不改 Provider/模型/单次预算。 */
export interface FrozenLlmExecution {
  domain_id: string;
  provider_id: string;
  /** 旧字段：等于 models[0].model，兼容无 models 的旧快照 */
  model: string;
  max_calls: number;
  max_tokens: number;
  /** 别名 → 真实模型（题目声明了非 default 别名时写入；缺省按单个 default 处理） */
  models?: { alias: string; model: string }[];
}

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
  domain_id: string;
  jti: string;
  /**
   * 本次评测的尝试 ID（Handbook §6.7）。
   *
   * 存在时 gateway 的单次额度键与吊销键按 attempt 维度隔离：
   * `llm:domain:<domain_id>:attempt:<attempt_id>:calls|tokens|cost` 与
   * `llm:attempt:revoked:<attempt_id>`。同一提交的重测因此拿到独立预算，
   * 且旧尝试的吊销不会误杀新尝试。
   */
  attempt_id: string;
  /** 本次评测使用的题目版本（审计与排查用，不参与限额计算）。 */
  problem_version_id: string | null;
  /** token 协议版本：`3` 强制使用域及评测尝试。 */
  protocol_version: number;
  submission_id: string;
  problem_id: string;
  user_id: string;
  provider_id: string;
  allowed_models: string[];
  /** 别名 → 真实模型名；仅题目使用非 default 别名时携带 */
  model_map?: Record<string, string>;
  iat: number;
  exp: number;
  max_calls: number;
  max_tokens: number;
}

/** 当前 LLM eval_token 协议版本（`3` = 使用域与 attempt 维度）。 */
export const LLM_TOKEN_PROTOCOL_VERSION = 3;

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
 * @param llmConfig 题目声明的 LLM 能力与预算（Provider / 模型由使用域决定）
 * @param submissionId 提交 ID
 * @param problemId 题目 ID
 * @param userId 提交用户 ID
 * @param runtimeConfig 题目 runtime_config（用于 TTL）
 * @param scope 本次评测的尝试与版本；正式提交必须传入（尝试维度预算与吊销）
 */
export async function buildJudgeTaskLlm(
  llmConfig: LlmConfig,
  submissionId: string,
  problemId: string,
  userId: string,
  runtimeConfig: RuntimeConfig,
  scope: {
    domainId?: string;
    attemptId: string;
    problemVersionId?: string | null;
    frozen?: FrozenLlmExecution;
  },
): Promise<JudgeTaskLlm> {
  const domainId = scope.domainId ?? DEFAULT_DOMAIN_ID;
  if (scope.frozen && scope.frozen.domain_id !== domainId) {
    throw new BadRequestError(
      "冻结的 LLM 配置不属于使用域",
      "LLM_DOMAIN_MISMATCH",
    );
  }
  const aliases = normalizeLlmModels(llmConfig);
  let resolved: GatewayResolvedModelSelection;
  if (scope.frozen) {
    resolved = {
      provider_id: scope.frozen.provider_id,
      models: scope.frozen.models ??
        [{ alias: LLM_DEFAULT_MODEL_ALIAS, model: scope.frozen.model }],
    };
  } else {
    try {
      resolved = await resolveLlmGatewayExecution(aliases, domainId);
    } catch (error) {
      if (
        error instanceof LlmGatewayError &&
        error.code === "domain_llm_not_configured"
      ) {
        throw new BadRequestError(
          "当前工作空间未配置 LLM Provider / 模型，无法评测 LLM 题",
          "DOMAIN_LLM_NOT_CONFIGURED",
        );
      }
      throw error;
    }
  }
  const defaultOnly = isDefaultOnly(resolved.models);
  const providerMissing = defaultOnly
    ? "当前工作空间默认 LLM Provider 不存在或已停用"
    : "题目所用模型别名对应的 LLM Provider 不存在或已停用";
  let provider;
  try {
    provider = await getLlmProviderById(resolved.provider_id, domainId);
  } catch (e) {
    // provider_not_found → 400（使用域配置指向了不存在的 Provider）；
    // 其余（gateway 不可达 / service token 缺失）原样上抛，按 5xx 处理，
    // 避免把服务端故障伪装成客户端错误。
    if (e instanceof LlmGatewayError && e.code === "provider_not_found") {
      throw new BadRequestError(providerMissing);
    }
    throw e;
  }
  if (!provider.enabled || provider.domain_id !== domainId) {
    throw new BadRequestError(providerMissing);
  }
  // 仅 default 时保持旧形态：allowed_models 为真实模型名且无 model_map
  const allowedModels = defaultOnly
    ? [resolved.models[0].model]
    : resolved.models.map((m) => m.alias);
  const modelMap = defaultOnly
    ? undefined
    : Object.fromEntries(resolved.models.map((m) => [m.alias, m.model]));

  const gatewayUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL") ??
    "http://localhost:8001";
  const timeLimitMs = runtimeConfig.evaluator.time_limit_ms;
  const ttlSeconds = Math.max(60, Math.ceil((timeLimitMs * 4) / 1000));
  const now = Math.floor(Date.now() / 1000);
  const limits = scope.frozen ?? resolveLlmLimits(llmConfig);
  const token = await mintEvalToken({
    domain_id: domainId,
    jti: crypto.randomUUID(),
    attempt_id: scope.attemptId,
    problem_version_id: scope.problemVersionId ?? null,
    protocol_version: LLM_TOKEN_PROTOCOL_VERSION,
    submission_id: submissionId,
    problem_id: problemId,
    user_id: userId,
    provider_id: resolved.provider_id,
    allowed_models: allowedModels,
    ...(modelMap ? { model_map: modelMap } : {}),
    iat: now,
    exp: now + ttlSeconds,
    max_calls: limits.max_calls,
    max_tokens: limits.max_tokens,
  });
  return {
    gateway_url: gatewayUrl,
    eval_token: token,
    provider_id: resolved.provider_id,
    allowed_models: allowedModels,
    ...(modelMap ? { model_map: modelMap } : {}),
  };
}
