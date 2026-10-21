import type { ReviewResult } from "../providers/types.ts";
import type { ReviewRuntimeConfig } from "./review-common.ts";

/**
 * 审核裁决：把 Provider 原始结论 + 风险分数映射到业务动作。
 *
 * 归一化规则（结合 content_review_risk_threshold / content_review_review_threshold）：
 * - Provider 明确 block，且（无分数或分数 ≥ riskThreshold）→ block（拒绝发布）
 * - Provider 明确 review → review（转人工）
 * - Provider 给出分数（无明确 verdict）：
 *   - 分数 ≥ riskThreshold → block
 *   - 分数 ≥ reviewThreshold → review
 *   - 其余 → pass
 * - 其余 → pass
 *
 * Provider 不可用/超时（verdict=error 或调用失败）由调用方在捕获处直接转 error → review。
 */
export type ReviewDecision =
  | { action: "block"; label?: string[]; riskLevel?: string }
  | { action: "review"; label?: string[]; riskLevel?: string }
  | { action: "pass"; label?: string[] };

export function decideReview(
  result: ReviewResult,
  config: ReviewRuntimeConfig,
): ReviewDecision {
  const score = result.score;
  const label = result.label;
  const riskLevel = result.riskLevel;

  const finalize = (
    action: ReviewDecision["action"],
  ): ReviewDecision => ({ action, label, riskLevel });

  switch (result.verdict) {
    case "block": {
      if (score === undefined || score >= config.riskThreshold) {
        return finalize("block");
      }
      // 分数低于拦截阈值的高置信标记：降级为疑似转人工
      return finalize("review");
    }
    case "review":
      return finalize("review");
    case "error":
      return finalize("review");
    case "pass":
    default:
      if (score !== undefined && score >= config.riskThreshold) {
        return finalize("block");
      }
      if (score !== undefined && score >= config.reviewThreshold) {
        return finalize("review");
      }
      return finalize("pass");
  }
}
