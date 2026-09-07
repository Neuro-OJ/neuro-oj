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
