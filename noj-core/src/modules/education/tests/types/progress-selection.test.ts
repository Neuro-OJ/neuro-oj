import { assertEquals } from "jsr:@std/assert@^1";
import {
  type EducationCandidate,
  selectAssignmentProgress,
} from "../../services/progress-selection.ts";

function candidate(
  score: number,
  accepted: boolean,
  id: string,
): EducationCandidate {
  return {
    submission_id: id,
    source_kind: "submission",
    user_id: "student",
    problem_id: "problem",
    scope: "current",
    received_at: "2026-10-01T00:00:00.000Z",
    receipt_sequence: 1,
    attempt_id: id,
    version_id: "v1",
    score,
    accepted,
    pending: false,
  };
}

Deno.test("学情选择：最高分不能反推正式通过，最低分要求不需要 AC", () => {
  const high = candidate(10000, false, "high"),
    lowAc = candidate(3000, true, "ac");
  const result = selectAssignmentProgress(
    [high, lowAc],
    "accepted",
    null,
    true,
    null,
  );
  assertEquals(result.status, "achieved");
  assertEquals(result.source_attempt_id, "high");
  assertEquals(result.accepted_attempt_id, "ac");
  assertEquals(
    selectAssignmentProgress([high], "accepted", null, true, null).status,
    "below_target",
  );
  assertEquals(
    selectAssignmentProgress(
      [candidate(6000, false, "60")],
      "min_score",
      6000,
      true,
      null,
    ).status,
    "achieved",
  );
});

Deno.test("学情选择：无候选、在途评测、已有成绩重测和资源不可用分别呈现", () => {
  const pending = {
    ...candidate(0, false, "pending"),
    score: null,
    attempt_id: null,
    pending: true,
  };
  assertEquals(
    selectAssignmentProgress([], "accepted", null, true, null).status,
    "not_started",
  );
  assertEquals(
    selectAssignmentProgress([pending], "accepted", null, true, null).status,
    "judging",
  );
  assertEquals(
    selectAssignmentProgress(
      [pending, candidate(10000, true, "ac")],
      "accepted",
      null,
      true,
      null,
    ).status,
    "achieved",
  );
  const unavailable = selectAssignmentProgress(
    [candidate(7000, false, "70")],
    "min_score",
    6000,
    false,
    null,
  );
  assertEquals(unavailable.status, "unavailable");
  assertEquals(unavailable.score, 7000);
});

Deno.test("学情选择：通过要求的逾期标记取真正的 AC 候选", () => {
  const earlyHigh = candidate(10000, false, "early");
  const lateAc = {
    ...candidate(3000, true, "late-ac"),
    received_at: "2026-10-03T00:00:00.000Z",
  };
  const deadline = "2026-10-02T00:00:00.000Z";
  assertEquals(
    selectAssignmentProgress(
      [earlyHigh, lateAc],
      "accepted",
      null,
      true,
      deadline,
    ).late,
    true,
  );
  assertEquals(
    selectAssignmentProgress(
      [earlyHigh, lateAc],
      "min_score",
      6000,
      true,
      deadline,
    ).late,
    false,
  );
});
