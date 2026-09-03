import { getSetting } from "../../system/index.ts";

/**
 * 内容合规审核公共配置读取与裁决（issue #413）。
 *
 * 读取 content_review_* 系统设置；上层 UGC 同步钩子与私信异步消费者共用。
 */

export interface ReviewRuntimeConfig {
  enabled: boolean;
  providerName: string;
  /** 高置信拦截阈值（0-100） */
  riskThreshold: number;
  /** 低置信疑似阈值（0-100） */
  reviewThreshold: number;
  /** 异步队列开关 */
  asyncEnabled: boolean;
  /** 单次调用超时（毫秒） */
  timeoutMs: number;
}

/** 读取当前审核运行配置。 */
export function getReviewConfig(): ReviewRuntimeConfig {
  const num = (key: string, fallback: number): number => {
    const raw = getSetting(key)?.value;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    enabled: getSetting("content_review_enabled")?.value === true,
    providerName: String(
      getSetting("content_review_provider")?.value ?? "mock",
    ),
    riskThreshold: num("content_review_risk_threshold", 80),
    reviewThreshold: num("content_review_review_threshold", 50),
    asyncEnabled: getSetting("content_review_async_enabled")?.value !== false,
    timeoutMs: num("content_review_timeout_ms", 3000),
  };
}

/**
 * 带超时的 Promise 包装：超过 timeoutMs 返回 null（由调用方按 fail-open 处理）。
 * @returns 原结果或 null（超时）
 */
export async function withReviewTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
