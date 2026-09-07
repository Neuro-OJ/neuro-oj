/**
 * 题目级 LLM 预算的默认值与解析/校验。
 *
 * 平台默认值同时是安全天花板：
 * - CRUD / bundle 导入在写库前调用 assertLlmLimitsWithinDefault 拒绝超限声明；
 * - eval_token 签发调用 resolveLlmLimits 做 Math.min 防御。
 */
import { BadRequestError } from "../../../shared/base/errors.ts";
import type { LlmConfig } from "../../catalog/index.ts";

/** 平台默认单次评测 LLM 预算（环境变量非法时回退的安全值）。 */
const DEFAULT_MAX_CALLS = 100;
const DEFAULT_MAX_TOKENS = 50_000;

/** 读取平台默认单次评测 LLM 预算；环境变量非法/非正数时回退默认值。 */
export function getDefaultLlmLimits(): {
  max_calls: number;
  max_tokens: number;
} {
  return {
    max_calls: readPositiveIntEnv("NOJ_LLM_MAX_CALLS", DEFAULT_MAX_CALLS),
    max_tokens: readPositiveIntEnv("NOJ_LLM_MAX_TOKENS", DEFAULT_MAX_TOKENS),
  };
}

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = Deno.env.get(key);
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 解析题目声明值；缺省用平台默认，声明值超过默认时截断到默认（防御）。 */
export function resolveLlmLimits(
  llm: Pick<LlmConfig, "max_calls" | "max_tokens">,
): { max_calls: number; max_tokens: number } {
  const defaults = getDefaultLlmLimits();
  return {
    max_calls: Math.max(
      1,
      Math.min(
        llm.max_calls ?? defaults.max_calls,
        defaults.max_calls,
      ),
    ),
    max_tokens: Math.max(
      1,
      Math.min(
        llm.max_tokens ?? defaults.max_tokens,
        defaults.max_tokens,
      ),
    ),
  };
}

/** 服务层写库前校验：题目声明值必须是正整数且不得超过平台默认。 */
export function assertLlmLimitsWithinDefault(
  llm: Pick<LlmConfig, "max_calls" | "max_tokens">,
): void {
  const defaults = getDefaultLlmLimits();
  if (
    llm.max_calls !== undefined &&
    (!Number.isInteger(llm.max_calls) || llm.max_calls <= 0)
  ) {
    throw new BadRequestError("llm.max_calls 必须是正整数");
  }
  if (
    llm.max_tokens !== undefined &&
    (!Number.isInteger(llm.max_tokens) || llm.max_tokens <= 0)
  ) {
    throw new BadRequestError("llm.max_tokens 必须是正整数");
  }
  if (llm.max_calls !== undefined && llm.max_calls > defaults.max_calls) {
    throw new BadRequestError("llm.max_calls 超过平台默认上限");
  }
  if (llm.max_tokens !== undefined && llm.max_tokens > defaults.max_tokens) {
    throw new BadRequestError("llm.max_tokens 超过平台默认上限");
  }
}
