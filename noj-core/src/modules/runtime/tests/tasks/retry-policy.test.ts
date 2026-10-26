/**
 * 后台任务退避策略纯逻辑测试（P4）。
 *
 * 不启动数据库、不依赖网络：只断言指数退避、上限与终态边界。
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  computeRetryDecision,
  isBackoffCapped,
  isTerminalFailure,
  RETRY_BASE_BACKOFF_MS,
  RETRY_MAX_BACKOFF_MS,
  RETRY_MAX_FAILURES,
} from "../../tasks/retry-policy.ts";

const NOW = 1_700_000_000_000;

Deno.test("retry-policy: 首次失败按基准退避", () => {
  const decision = computeRetryDecision(1, NOW);
  assertEquals(decision.backoffMs, RETRY_BASE_BACKOFF_MS);
  assertEquals(decision.availableAtMs, NOW + RETRY_BASE_BACKOFF_MS);
  assertEquals(decision.terminal, false);
});

Deno.test("retry-policy: 指数退避逐次翻倍", () => {
  assertEquals(
    computeRetryDecision(2, NOW).backoffMs,
    RETRY_BASE_BACKOFF_MS * 2,
  );
  assertEquals(
    computeRetryDecision(3, NOW).backoffMs,
    RETRY_BASE_BACKOFF_MS * 4,
  );
  assertEquals(
    computeRetryDecision(4, NOW).backoffMs,
    RETRY_BASE_BACKOFF_MS * 8,
  );
});

Deno.test("retry-policy: 退避不超过 5 分钟上限", () => {
  for (const failureCount of [1, 5, 10, 19]) {
    const decision = computeRetryDecision(failureCount, NOW);
    assertEquals(decision.backoffMs <= RETRY_MAX_BACKOFF_MS, true);
  }
  // 大失败次数必须被截断在上限，不能溢出成巨大间隔。
  assertEquals(computeRetryDecision(19, NOW).backoffMs, RETRY_MAX_BACKOFF_MS);
  assertEquals(isBackoffCapped(19), true);
  assertEquals(isBackoffCapped(1), false);
});

Deno.test("retry-policy: 连续失败 20 次转入终态且不再安排重试", () => {
  const terminal = computeRetryDecision(RETRY_MAX_FAILURES, NOW);
  assertEquals(terminal.terminal, true);
  assertEquals(terminal.backoffMs, 0);
  assertEquals(terminal.availableAtMs, NOW);
  assertEquals(isTerminalFailure(RETRY_MAX_FAILURES), true);
  assertEquals(isTerminalFailure(RETRY_MAX_FAILURES - 1), false);
});

Deno.test("retry-policy: 非法入参显式失败", () => {
  assertThrows(() => computeRetryDecision(0, NOW), RangeError);
  assertThrows(() => computeRetryDecision(-1, NOW), RangeError);
  assertThrows(() => computeRetryDecision(1.5, NOW), RangeError);
  assertThrows(() => computeRetryDecision(1, Number.NaN), RangeError);
  assertThrows(() => isBackoffCapped(0), RangeError);
});
