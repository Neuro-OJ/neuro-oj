/**
 * 后台任务退避策略（P4，纯逻辑，不触库）。
 *
 * 语义固定（交接文档 §4.2）：
 * - 指数退避：`base * 2^(failures-1)`，上限 5 分钟；
 * - 连续失败 20 次转入终态 `failed`；
 * - 时间边界一律用"已发生次数"计算，不依赖调用时钟，便于纯逻辑测试。
 */

/** 连续失败上限；达到即终态失败。 */
export const RETRY_MAX_FAILURES = 20;

/** 退避上限：5 分钟。 */
export const RETRY_MAX_BACKOFF_MS = 5 * 60 * 1000;

/** 首次退避基准：5 秒。 */
export const RETRY_BASE_BACKOFF_MS = 5 * 1000;

/** 一次失败后的调度决策。 */
export interface RetryDecision {
  /** 下一次可领取时刻（毫秒时间戳）。 */
  readonly availableAtMs: number;
  /** 是否已进入终态失败（不再自动重试）。 */
  readonly terminal: boolean;
  /** 本次失败后的连续失败次数。 */
  readonly failureCount: number;
  /** 本次退避毫秒数；终态失败为 0。 */
  readonly backoffMs: number;
}

/**
 * 计算一次失败后的退避。
 *
 * @param failureCount 本次失败后的连续失败次数（从 1 开始）
 * @param nowMs 当前时刻（毫秒时间戳），由调用方从 DB 时间取得
 */
export function computeRetryDecision(
  failureCount: number,
  nowMs: number,
): RetryDecision {
  if (!Number.isInteger(failureCount) || failureCount < 1) {
    throw new RangeError("连续失败次数必须是正整数");
  }
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("当前时刻必须是有限毫秒时间戳");
  }
  if (failureCount >= RETRY_MAX_FAILURES) {
    return {
      availableAtMs: nowMs,
      terminal: true,
      failureCount,
      backoffMs: 0,
    };
  }
  // 指数退避：5s, 10s, 20s, ... 直到上限；用位移避免 Math.pow 的浮点误差。
  const exponent = Math.min(failureCount - 1, 20);
  const raw = RETRY_BASE_BACKOFF_MS * 2 ** exponent;
  const backoffMs = Math.min(raw, RETRY_MAX_BACKOFF_MS);
  return {
    availableAtMs: nowMs + backoffMs,
    terminal: false,
    failureCount,
    backoffMs,
  };
}

/** 退避上限是否已生效（用于边界测试与文档断言）。 */
export function isBackoffCapped(failureCount: number): boolean {
  if (!Number.isInteger(failureCount) || failureCount < 1) {
    throw new RangeError("连续失败次数必须是正整数");
  }
  const exponent = Math.min(failureCount - 1, 20);
  return RETRY_BASE_BACKOFF_MS * 2 ** exponent >= RETRY_MAX_BACKOFF_MS;
}

/** 是否应在该失败次数后停止自动重试。 */
export function isTerminalFailure(failureCount: number): boolean {
  return failureCount >= RETRY_MAX_FAILURES;
}
