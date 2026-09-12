/**
 * 评测结果防御性归一测试（2026-09-12 架构评审 §4.3）。
 *
 * 覆盖：脏分数进入榜单 SQL 的路径、非法状态、负数耗时/内存、非法 output 类型。
 * 纯函数测试，不依赖数据库。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  ALLOWED_JUDGE_STATUSES,
  sanitizeJudgeResult,
} from "../../services/submissions/sanitize-judge-result.ts";
import type { JudgeResult } from "../../types/index.ts";

function result(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    submission_id: "11111111-1111-4111-8111-111111111111",
    status: "finished",
    score: 10000,
    output: "ok",
    details: {},
    ...overrides,
  };
}

Deno.test("sanitize-judge-result: 合法结果原样通过", () => {
  const { result: safe, adjustments } = sanitizeJudgeResult(
    result({ score: 5000, time_ms: 42, memory_kb: 1024 }),
  );
  assertEquals(adjustments, []);
  assertEquals(safe.score, 5000);
  assertEquals(safe.status, "finished");
  assertEquals(safe.time_ms, 42);
  assertEquals(safe.memory_kb, 1024);
});

Deno.test("sanitize-judge-result: 超范围分数被 clamp（脏分数不得进入榜单）", () => {
  const high = sanitizeJudgeResult(result({ score: 999999 }));
  assertEquals(high.result.score, 10000);
  assertEquals(high.adjustments.length, 1);

  const negative = sanitizeJudgeResult(result({ score: -500 }));
  assertEquals(negative.result.score, 0);
  assertEquals(negative.adjustments.length, 1);
});

Deno.test("sanitize-judge-result: 非数值分数降级为 0", () => {
  const nan = sanitizeJudgeResult(result({ score: Number.NaN }));
  assertEquals(nan.result.score, 0);
  const stringScore = sanitizeJudgeResult(
    result({ score: "10000" as unknown as number }),
  );
  assertEquals(stringScore.result.score, 0);
  const infinite = sanitizeJudgeResult(
    result({ score: Number.POSITIVE_INFINITY }),
  );
  assertEquals(infinite.result.score, 0);
});

Deno.test("sanitize-judge-result: 未知状态降级为 error", () => {
  const unknown = sanitizeJudgeResult(result({ status: "weird_status" }));
  assertEquals(unknown.result.status, "error");
  assertEquals(unknown.adjustments.length, 1);
  // 白名单内的失败归因保持不变
  for (const status of ALLOWED_JUDGE_STATUSES) {
    const out = sanitizeJudgeResult(result({ status }));
    assertEquals(out.result.status, status);
    assertEquals(out.adjustments.length, 0);
  }
});

Deno.test("sanitize-judge-result: 负数/非法耗时与内存被清空", () => {
  const negative = sanitizeJudgeResult(
    result({ time_ms: -1, memory_kb: -1 }),
  );
  assertEquals(negative.result.time_ms, undefined);
  assertEquals(negative.result.memory_kb, undefined);
  assertEquals(negative.adjustments.length, 2);

  const nan = sanitizeJudgeResult(
    result({ time_ms: Number.NaN, memory_kb: Number.POSITIVE_INFINITY }),
  );
  assertEquals(nan.result.time_ms, undefined);
  assertEquals(nan.result.memory_kb, undefined);

  // 缺省值不算异常
  const absent = sanitizeJudgeResult(result());
  assertEquals(absent.adjustments.length, 0);
});

Deno.test("sanitize-judge-result: 非字符串 output 归一为空串", () => {
  const out = sanitizeJudgeResult(
    result({ output: { nested: true } as unknown as string }),
  );
  assertEquals(out.result.output, "");
  assertEquals(out.adjustments.length, 1);
});

Deno.test("sanitize-judge-result: 不修改入参对象", () => {
  const original = result({ score: 999999, status: "bogus" });
  const snapshot = { ...original };
  sanitizeJudgeResult(original);
  assertEquals(original.score, snapshot.score);
  assertEquals(original.status, snapshot.status);
});
