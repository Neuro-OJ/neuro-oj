import { assertEquals } from "jsr:@std/assert@^1";
import {
  contestAllowsProblem,
  type ContestScoreSubmission,
  scoreContest,
  weightedContestScore,
} from "../../services/contest-scoring.ts";
import {
  type ContestType,
  isValidContestConfig,
} from "../../types/contests.ts";

const start = "2026-10-12T00:00:00.000Z", end = "2026-10-12T02:00:00.000Z";
function submission(
  sequence: number,
  score: number | null,
  overrides: Partial<ContestScoreSubmission> = {},
): ContestScoreSubmission {
  return {
    id: `s${sequence}`,
    user_id: "student",
    problem_id: "p",
    received_at: new Date(Date.parse(start) + sequence * 60_000).toISOString(),
    receipt_sequence: String(sequence),
    state: score === null ? "pending" : "graded",
    score,
    accepted: score === 10000,
    verdict: score === 10000 ? "AC" : "WA",
    attempt_id: `a${sequence}`,
    ...overrides,
  };
}
function rank(type: ContestType, submissions: ContestScoreSubmission[]) {
  return scoreContest({
    type,
    start_time: start,
    end_time: end,
    participants: ["student"],
    problems: [{
      id: "p",
      kind: type === "kaggle" ? "ai" : "oi",
      max_score: 10000,
    }],
    submissions,
  })[0];
}

Deno.test("多赛制：最高分与最后受理提交，平台错误不能回退早期成绩", () => {
  const sequence = [submission(1, 10000), submission(2, 2000)];
  assertEquals(rank("kaggle", sequence).total_score, 10000);
  for (const type of ["oi", "ioi", "ioi_strict"] as const) {
    assertEquals(rank(type, sequence).total_score, 2000);
    const ce = rank(type, [...sequence, submission(3, 0, { verdict: "CE" })]);
    assertEquals(ce.problems[0].submission_id, "s3");
    assertEquals(ce.total_score, 0);
    for (const state of ["pending", "platform_error"] as const) {
      const unresolved = rank(type, [
        ...sequence,
        submission(3, null, { state }),
      ]);
      assertEquals(unresolved.problems[0].score, null);
      assertEquals(unresolved.problems[0].submission_id, "s3");
      assertEquals(unresolved.pending, true);
    }
  }
});

Deno.test("ACM：首 AC 与计罚失败，CE 平台错误及 AC 后提交不计罚", () => {
  const sequence = [
    submission(1, 0),
    submission(2, 0, { verdict: "CE" }),
    submission(3, 0),
    submission(4, 10000),
    submission(5, 0),
  ];
  const row = rank("acm", sequence);
  assertEquals(row.solved, 1);
  assertEquals(row.penalty_ms, (4 + 40) * 60_000);
  assertEquals(row.problems[0].submission_id, "s4");
  const errored = rank("acm", [
    submission(1, null, { state: "platform_error" }),
    submission(4, 10000),
  ]);
  assertEquals(errored.penalty_ms, 4 * 60_000);
  assertEquals(errored.pending, true);
  const rejudged = rank(
    "acm",
    sequence.map((s) =>
      s.id === "s4" ? { ...s, score: 0, accepted: false, verdict: "WA" } : s
    ),
  );
  assertEquals(rejudged.solved, 0);
});

Deno.test("计分：同毫秒按可靠序号、受理窗口、原始客观题分与整数舍入", () => {
  const sameTime = [
    submission(1, 10000),
    submission(2, 2000, { received_at: submission(1, 10000).received_at }),
  ];
  assertEquals(rank("oi", [...sameTime].reverse()).total_score, 2000);
  assertEquals(
    rank("oi", [
      submission(1, 2000),
      submission(2, 10000, {
        received_at: "2026-10-12T02:00:00.001Z",
      }),
      submission(3, 10000, { received_at: "2026-10-11T23:59:59.999Z" }),
    ]).total_score,
    2000,
  );
  assertEquals(
    weightedContestScore(3333, { id: "p", kind: "oi", max_score: 3000 }),
    1000,
  );
  assertEquals(
    weightedContestScore(7500, { id: "p", kind: "objective", max_score: 3000 }),
    7500,
  );
  // 超出 Number 精确整数范围的序号仍保持正确顺序。
  assertEquals(
    rank("ioi", [
      submission(1, 10000, { receipt_sequence: "9007199254740992" }),
      submission(2, 2000, { receipt_sequence: "9007199254740993" }),
    ]).total_score,
    2000,
  );
});

Deno.test("排名：OI 同分及 ACM 同解题数同罚时并列，ID 只稳定列表", () => {
  for (const type of ["oi", "ioi", "ioi_strict", "acm"] as const) {
    const rows = scoreContest({
      type,
      start_time: start,
      end_time: end,
      participants: ["z", "a"],
      problems: [{ id: "p", kind: "oi", max_score: 10000 }],
      submissions: [
        submission(1, 10000, { user_id: "z" }),
        submission(1, 10000, { user_id: "a" }),
      ],
    });
    assertEquals(rows.map((r) => [r.user_id, r.rank]), [["a", 1], ["z", 1]]);
  }
});

Deno.test("赛制配置：允许题型和 ACM 可配置罚时", () => {
  assertEquals(
    ["ai", "oi", "objective"].map((kind) =>
      contestAllowsProblem("kaggle", kind as "ai" | "oi" | "objective")
    ),
    [true, false, true],
  );
  assertEquals(
    ["ai", "oi", "objective"].map((kind) =>
      contestAllowsProblem("oi", kind as "ai" | "oi" | "objective")
    ),
    [false, true, true],
  );
  for (const type of ["ioi", "ioi_strict", "acm"] as const) {
    assertEquals(contestAllowsProblem(type, "objective"), false);
    assertEquals(contestAllowsProblem(type, "oi"), true);
  }
  assertEquals(isValidContestConfig("acm", { penalty_minutes: 10 }), true);
  assertEquals(isValidContestConfig("acm", { penalty_minutes: -1 }), false);
  assertEquals(isValidContestConfig("oi", { penalty_minutes: 20 }), false);
});
