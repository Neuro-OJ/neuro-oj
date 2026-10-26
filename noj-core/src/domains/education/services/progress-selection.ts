/** 学情只读取当前正式判定的允许摘要，不接收 evaluator 原始文本。 */
export interface EducationCandidate {
  submission_id: string;
  source_kind: "submission" | "objective";
  user_id: string;
  problem_id: string;
  scope: "on_time" | "current";
  received_at: string;
  receipt_sequence: number;
  attempt_id: string | null;
  version_id: string | null;
  score: number | null;
  accepted: boolean;
  pending: boolean;
}

/** 最高分和正式通过独立选择；正在评测不能抹去已有正式成绩。 */
export function selectAssignmentProgress(
  candidates: EducationCandidate[],
  requirement: "accepted" | "min_score",
  minimumScore: number | null,
  available: boolean,
  deadline: string | null,
) {
  const ordered = [...candidates].filter((c) =>
    c.attempt_id !== null && c.score !== null
  )
    .sort((a, b) =>
      b.score! - a.score! || a.receipt_sequence - b.receipt_sequence ||
      a.attempt_id!.localeCompare(b.attempt_id!)
    );
  const best = ordered[0] ?? null;
  const passed = ordered.find((c) => c.accepted) ?? null;
  const achieved = requirement === "accepted"
    ? passed !== null
    : best !== null && best.score! >= minimumScore!;
  const status = !available
    ? "unavailable"
    : achieved
    ? "achieved"
    : candidates.some((c) => c.pending)
    ? "judging"
    : best
    ? "below_target"
    : "not_started";
  return {
    status,
    score: best?.score ?? null,
    accepted: passed !== null,
    source_submission_id: best?.submission_id ?? null,
    source_kind: best?.source_kind ?? null,
    source_attempt_id: best?.attempt_id ?? null,
    evaluated_version_id: best?.version_id ?? null,
    accepted_attempt_id: passed?.attempt_id ?? null,
    late: deadline !== null &&
      (requirement === "accepted" && passed
          ? passed.received_at
          : best?.received_at ?? "") > deadline,
  } as const;
}
