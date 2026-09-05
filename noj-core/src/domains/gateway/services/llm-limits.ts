/**
 * 题目级 LLM 预算的默认值与解析/校验。
 *
 * 平台默认值同时是安全天花板：
 * - CRUD / bundle 导入在写库前调用 assertLlmLimitsWithinDefault 拒绝超限声明；
 * - eval_token 签发调用 resolveLlmLimits 做 Math.min 防御。
 */
import { BadRequestError } from "../../../shared/base/errors.ts";
import type { LlmConfig } from "../../catalog/index.ts";

/** 读取平台默认单次评测 LLM 预算。 */
export function getDefaultLlmLimits(): {
  max_calls: number;
  max_tokens: number;
} {
  return {
    max_calls: Number(Deno.env.get("NOJ_LLM_MAX_CALLS") ?? "100"),
    max_tokens: Number(Deno.env.get("NOJ_LLM_MAX_TOKENS") ?? "50000"),
  };
}

/** 解析题目声明值；缺省用平台默认，声明值超过默认时截断到默认（防御）。 */
export function resolveLlmLimits(
  llm: Pick<LlmConfig, "max_calls" | "max_tokens">,
): { max_calls: number; max_tokens: number } {
  const defaults = getDefaultLlmLimits();
  return {
    max_calls: Math.min(
      llm.max_calls ?? defaults.max_calls,
      defaults.max_calls,
    ),
    max_tokens: Math.min(
      llm.max_tokens ?? defaults.max_tokens,
      defaults.max_tokens,
    ),
  };
}

/** 服务层写库前校验：题目声明值不得超过平台默认。 */
export function assertLlmLimitsWithinDefault(
  llm: Pick<LlmConfig, "max_calls" | "max_tokens">,
): void {
  const defaults = getDefaultLlmLimits();
  if (llm.max_calls !== undefined && llm.max_calls > defaults.max_calls) {
    throw new BadRequestError("llm.max_calls 超过平台默认上限");
  }
  if (llm.max_tokens !== undefined && llm.max_tokens > defaults.max_tokens) {
    throw new BadRequestError("llm.max_tokens 超过平台默认上限");
  }
}
