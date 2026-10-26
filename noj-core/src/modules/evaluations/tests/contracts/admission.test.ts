import { assertThrows } from "jsr:@std/assert@^1";
import {
  assertEvaluationAdmission,
  type EvaluationAdmissionContext,
} from "../../contracts/read.ts";

const context: EvaluationAdmissionContext = {
  problem: {
    problemId: "problem-1",
    versionId: "problem-1-v2",
    version: 2,
    content: {
      kind: "objective",
      title: "合同题",
      description: "",
      samples: [],
      questions: [],
    },
    submissionMode: "code",
    judgeType: "dual",
  },
  access: {
    problemId: "problem-1",
    allowed: true,
    canSubmit: true,
    mode: "public",
  },
  contest: {
    contestId: "contest-1",
    problemId: "problem-1",
    pinnedVersionId: "problem-1-v2",
    effectiveVersionMode: "exact",
    requiredVersionId: "problem-1-v2",
    policyRevision: 4,
    submissionLimit: null,
    running: true,
    secrecy: true,
  },
  assignment: null,
};

Deno.test("evaluations admission: 接受已经组合的题目/版本/比赛快照", () => {
  assertEvaluationAdmission(context, {
    problemId: "problem-1",
    versionId: "problem-1-v2",
    contestId: "contest-1",
  });
});

Deno.test("evaluations admission: 拒绝缺少提交权限的快照", () => {
  assertThrows(() =>
    assertEvaluationAdmission(
      { ...context, access: { ...context.access, canSubmit: false } },
      {
        problemId: "problem-1",
        versionId: "problem-1-v2",
        contestId: "contest-1",
      },
    )
  );
});

Deno.test("evaluations admission: 拒绝跨题/过期版本/比赛上下文", () => {
  assertThrows(() =>
    assertEvaluationAdmission(context, {
      problemId: "problem-2",
      versionId: "problem-1-v2",
      contestId: "contest-1",
    })
  );
  assertThrows(() =>
    assertEvaluationAdmission(context, {
      problemId: "problem-1",
      versionId: "problem-1-v1",
      contestId: "contest-1",
    })
  );
  assertThrows(() =>
    assertEvaluationAdmission(context, {
      problemId: "problem-1",
      versionId: "problem-1-v2",
      contestId: null,
    })
  );
});

Deno.test("evaluations admission: 比赛关闭时拒绝继续受理", () => {
  assertThrows(() =>
    assertEvaluationAdmission(
      { ...context, contest: { ...context.contest!, running: false } },
      {
        problemId: "problem-1",
        versionId: "problem-1-v2",
        contestId: "contest-1",
      },
    )
  );
});
