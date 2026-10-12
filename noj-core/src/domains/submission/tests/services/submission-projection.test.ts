import { assertEquals } from "jsr:@std/assert@^1";
import {
  applySubmissionProjection,
  type ProjectionCtx,
} from "../../services/submissions/submission-projection.ts";

function baseSubmission(): Record<string, unknown> {
  return {
    id: "sub-1",
    problem_id: "problem-1",
    user_id: "user-a",
    status: "finished",
    score: 90,
    output: "hidden output",
    details: {
      cases: [
        { id: "c1", hidden: false, result: "ok" },
        { id: "c2", hidden: true, result: "fail" },
      ],
    },
    subtasks: [{ id: "s1", score: 50 }],
    testCases: [{ id: "t1" }],
  };
}

Deno.test("projection: admin 全量", () => {
  const input = baseSubmission();
  const result = applySubmissionProjection(input, {
    viewerId: "admin",
    isAdmin: true,
    isOwner: false,
    contest: { running: true, participant: true },
  } as ProjectionCtx);
  assertEquals(result, input);
});

Deno.test("projection: 提交者本人/owner 全量", () => {
  const input = baseSubmission();
  const result = applySubmissionProjection(input, {
    viewerId: "user-a",
    isAdmin: false,
    isOwner: true,
    contest: null,
  });
  assertEquals(result, input);
});

Deno.test("projection: 无竞赛上下文原样返回", () => {
  const input = baseSubmission();
  const result = applySubmissionProjection(input, {
    viewerId: "user-b",
    isAdmin: false,
    isOwner: false,
    contest: null,
  });
  assertEquals(result, input);
});

Deno.test("projection: 赛中参赛者本人保分剥 hidden", () => {
  const input = baseSubmission();
  const result = applySubmissionProjection(input, {
    viewerId: "user-a",
    isAdmin: false,
    isOwner: true,
    contest: { running: true, participant: true },
  });
  assertEquals(result.status, "finished");
  assertEquals(result.score, 90);
  assertEquals(result.subtasks, undefined);
  assertEquals(result.testCases, undefined);
  assertEquals(result.output, undefined);
  const cases = (result.details as { cases: Array<Record<string, unknown>> })
    .cases;
  assertEquals(cases, [{ id: "c1", hidden: false, result: "ok" }]);
});

Deno.test("projection: 赛中他人仅有存在级信息", () => {
  const input = baseSubmission();
  const result = applySubmissionProjection(input, {
    viewerId: "user-b",
    isAdmin: false,
    isOwner: false,
    contest: { running: true, participant: true },
  });
  assertEquals(result, {
    id: "sub-1",
    problem_id: "problem-1",
    status: "finished",
  });
});

Deno.test("projection: 赛后参赛者本人保分但 hidden 仍剥离", () => {
  const input = baseSubmission();
  const result = applySubmissionProjection(input, {
    viewerId: "user-a",
    isAdmin: false,
    isOwner: true,
    contest: { running: false, participant: true },
  });
  assertEquals(result.status, "finished");
  assertEquals(result.score, 90);
  const cases = (result.details as { cases: Array<Record<string, unknown>> })
    .cases;
  assertEquals(cases, [{ id: "c1", hidden: false, result: "ok" }]);
  assertEquals(
    cases.some((c) => c.hidden === true),
    false,
  );
});

Deno.test("projection: 旧脚本无 hidden 标记 fail-safe 全剥", () => {
  const input = {
    ...baseSubmission(),
    details: {
      cases: [
        { id: "c1", result: "ok" },
        { id: "c2", result: "fail" },
      ],
    },
  };
  const result = applySubmissionProjection(input, {
    viewerId: "user-a",
    isAdmin: false,
    isOwner: true,
    contest: { running: true, participant: true },
  });
  assertEquals(result.details, undefined);
});

Deno.test("projection: visibility=hidden 同样被剥离", () => {
  const input = {
    ...baseSubmission(),
    details: {
      cases: [
        { id: "c1", visibility: "visible", result: "ok" },
        { id: "c2", visibility: "hidden", result: "fail" },
      ],
    },
  };
  const result = applySubmissionProjection(input, {
    viewerId: "user-a",
    isAdmin: false,
    isOwner: true,
    contest: { running: true, participant: true },
  });
  const cases = (result.details as { cases: Array<Record<string, unknown>> })
    .cases;
  assertEquals(cases, [{ id: "c1", visibility: "visible", result: "ok" }]);
});

Deno.test("projection: OI在非竞赛中也禁止隐藏内容与checker诊断", () => {
  const projected = applySubmissionProjection({
    id: "s",
    user_id: "u",
    output: "secret",
    details: {
      oi: {
        verdict: "WA",
        backend: "native",
        checker_message: "secret",
        subtasks: [{
          id: "s1",
          score: 0,
          verdict: "WA",
          cases: [{
            case_id: "1",
            verdict: "WA",
            input: "secret",
            actual_output: "secret",
            time_ms: 1,
          }],
        }],
      },
    },
  }, { viewerId: "u", isAdmin: false, isOwner: true });
  assertEquals(JSON.stringify(projected).includes("secret"), false);
  assertEquals((projected as Record<string, unknown>).verdict, "WA");
});

Deno.test("projection: 仅公开标准摘要和 fuel，不暴露隐藏测试或任意计量字段", () => {
  const hash = "a".repeat(64);
  const projected = applySubmissionProjection({
    id: "s",
    user_id: "u",
    result: {
      details: {
        metering: {
          standard_version: "noj-wasm-v1",
          standard_hash: hash,
          source_hash: hash,
          evaluation_hash: hash,
          comparison_hash: hash,
          comparable: true,
          secret: "hidden-data",
        },
        oi: {
          backend: "wasm",
          verdict: "AC",
          subtasks: [{
            id: "all",
            cases: [{
              status: "AC",
              fuel_consumed: 10,
              fuel_budget: 100,
              input: "hidden-data",
            }],
          }],
        },
      },
    },
  }, { viewerId: "u", isAdmin: false, isOwner: true });
  assertEquals(JSON.stringify(projected).includes("hidden-data"), false);
  assertEquals((projected.result as Record<string, unknown>).metering, {
    standard_version: "noj-wasm-v1",
    standard_hash: hash,
    source_hash: hash,
    evaluation_hash: hash,
    comparison_hash: hash,
    comparable: true,
    legacy: false,
  });
});
