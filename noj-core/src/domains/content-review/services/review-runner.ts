import type { ContentReviewProvider } from "../providers/types.ts";
import { createReviewProvider } from "../providers/index.ts";
import { decideReview } from "./review-decision.ts";
import { getReviewConfig, withReviewTimeout } from "./review-common.ts";
import { enqueueReview, type ReviewContentType } from "./review-queue.ts";
import { logger } from "../../../lib/logging.ts";

/**
 * 审核执行器：UGC 同步钩子与私信异步消费者共用的统一入口。
 *
 * 流程：开关检查 → 取 Provider → 送审（带超时）→ 裁决 → 落 content_review_queue。
 * Provider 不可用/超时/异常 → 按 fail-open 转人工（verdict=error, status=pending_review），
 * 完全不阻断业务。
 */

export type ReviewOutcome =
  | { action: "block"; label?: string[]; riskLevel?: string }
  | { action: "review" }
  | { action: "pass" };

interface RunReviewInput {
  content_type: ReviewContentType;
  target_id: string;
  channel: "ugc" | "dm";
  /** 送审文本（UGC 传 title+content，私信传 content） */
  text: string;
  /** 上下文 JSON（meta 列，详情端点展示用） */
  meta?: Record<string, unknown>;
  /** 是否启用（同步钩子传总开关；异步消费者由 producer 侧已把关，但再查一次） */
  enabled: boolean;
}

// 测试注入点：覆盖 Provider 工厂（仿 _resetConsumerShutdownForTest 模式）
let providerFactoryForTest: (() => ContentReviewProvider | null) | null = null;

/** 测试用：注入自定义 Provider 工厂（传 null 恢复默认）。 */
export function _setReviewProviderFactoryForTest(
  factory: (() => ContentReviewProvider | null) | null,
): void {
  providerFactoryForTest = factory;
}

/**
 * 执行一次内容审核并落库。
 * @returns block：上层应拒绝发布；review：发布成功但已入人工队列；pass：机器放行。
 */
export async function runContentReview(
  input: RunReviewInput,
): Promise<ReviewOutcome> {
  const config = getReviewConfig();

  // 总开关关闭（或调用方按场景关闭）→ 不审核
  if (!config.enabled || !input.enabled) {
    return { action: "pass" };
  }

  const provider = providerFactoryForTest
    ? providerFactoryForTest()
    : createReviewProvider();

  // 未配置可用 Provider（none / 密钥缺失）→ fail-open 转人工
  if (!provider) {
    await enqueueReview({
      content_type: input.content_type,
      target_id: input.target_id,
      channel: input.channel,
      status: "pending_review",
      review_provider: "none",
      verdict: "error",
      content_snapshot: input.text,
      meta: input.meta,
    });
    return { action: "review" };
  }

  let result;
  try {
    result = await withReviewTimeout(
      provider.reviewText(input.text, {
        content_type: input.content_type,
        maxLength: 2000,
      }),
      config.timeoutMs,
    );
  } catch (err) {
    logger.warn("[content-review] 审核调用异常，fail-open 转人工", {
      err,
      provider: provider.name,
    });
    result = null;
  }

  // 超时 / 异常 → fail-open 转人工
  if (!result) {
    await enqueueReview({
      content_type: input.content_type,
      target_id: input.target_id,
      channel: input.channel,
      status: "pending_review",
      review_provider: provider.name,
      verdict: "error",
      content_snapshot: input.text,
      meta: input.meta,
    });
    return { action: "review" };
  }

  const decision = decideReview(result, config);

  if (decision.action === "block") {
    // 私信（异步渠道）不做即时拦截：block 降级为"标记转人工"，由管理员在
    // 统一审查队列处置（查看上下文 + 记录/封禁），接收方不受即时影响。
    if (input.channel === "dm") {
      await enqueueReview({
        content_type: input.content_type,
        target_id: input.target_id,
        channel: input.channel,
        status: "pending_review",
        review_provider: provider.name,
        verdict: result.verdict,
        label: result.label,
        hit_words: result.hitWords,
        risk_level: decision.riskLevel ?? result.riskLevel,
        content_snapshot: input.text,
        meta: input.meta,
      });
      return { action: "review" };
    }
    // UGC 高置信拦截：写 rejected 留痕（内容本身未发布/未落库）
    await enqueueReview({
      content_type: input.content_type,
      target_id: input.target_id,
      channel: input.channel,
      status: "rejected",
      review_provider: provider.name,
      verdict: result.verdict,
      label: result.label,
      hit_words: result.hitWords,
      risk_level: decision.riskLevel ?? result.riskLevel,
      content_snapshot: input.text,
      meta: input.meta,
    });
    return {
      action: "block",
      label: decision.label,
      riskLevel: decision.riskLevel,
    };
  }

  if (decision.action === "review") {
    // 疑似 → 转人工（内容正常发布/送达）
    await enqueueReview({
      content_type: input.content_type,
      target_id: input.target_id,
      channel: input.channel,
      status: "pending_review",
      review_provider: provider.name,
      verdict: result.verdict,
      label: result.label,
      hit_words: result.hitWords,
      risk_level: decision.riskLevel ?? result.riskLevel,
      content_snapshot: input.text,
      meta: input.meta,
    });
    return { action: "review" };
  }

  // pass → 机器放行留痕（approved）
  await enqueueReview({
    content_type: input.content_type,
    target_id: input.target_id,
    channel: input.channel,
    status: "approved",
    review_provider: provider.name,
    verdict: result.verdict,
    label: result.label,
    hit_words: result.hitWords,
    risk_level: result.riskLevel,
    content_snapshot: input.text,
    meta: input.meta,
  });
  return { action: "pass" };
}
