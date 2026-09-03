/**
 * LLM 用量 billed-token 计算。
 *
 * OpenAI 兼容上游可能在 usage.prompt_tokens_details.cached_tokens 返回缓存命中
 * 的 prompt token；真实计费/限额应按 billed = (prompt - cached) + completion。
 */
export interface UpstreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface BilledUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  billedPromptTokens: number;
  billedTotalTokens: number;
}

/** 计算 billed usage；无上游 usage 时回退到估算值。 */
export function calcBilledUsage(
  usage: UpstreamUsage | undefined,
  fallbackPromptTokens: number,
  fallbackCompletionTokens: number,
): BilledUsage {
  const promptTokens = Math.floor(usage?.prompt_tokens ?? fallbackPromptTokens);
  const completionTokens = Math.floor(
    usage?.completion_tokens ?? fallbackCompletionTokens,
  );
  const cachedPromptTokens = Math.max(
    0,
    Math.floor(usage?.prompt_tokens_details?.cached_tokens ?? 0),
  );
  const billedPromptTokens = Math.max(0, promptTokens - cachedPromptTokens);
  const totalTokens = Math.floor(
    usage?.total_tokens ?? (promptTokens + completionTokens),
  );
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens,
    billedPromptTokens,
    billedTotalTokens: billedPromptTokens + completionTokens,
  };
}
