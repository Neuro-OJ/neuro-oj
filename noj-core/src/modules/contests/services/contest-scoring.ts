import type { ContestType } from "../types/contests.ts";

/** 计分只接受后端解析的正式判定；受理顺序独立于评测完成顺序。 */
export interface ContestScoreSubmission {
  id: string;
  user_id: string;
  problem_id: string;
  received_at: string;
  receipt_sequence: string;
  state: "pending" | "platform_error" | "graded";
  score: number | null;
  accepted: boolean;
  verdict: string | null;
  attempt_id: string | null;
}

/** 题目满分和题型来自比赛固定版本。 */
export interface ContestScoreProblem {
  id: string;
  kind: "ai" | "oi" | "objective";
  max_score: number;
}

/** 单题的当前成绩及依据。null 分数表示等待处理，不伪造正式零分。 */
export interface ContestScoreCell {
  problem_id: string;
  submission_id: string | null;
  attempt_id: string | null;
  score: number | null;
  accepted: boolean;
  pending: boolean;
  attempts: number;
  penalty_ms: number;
}

/** 各赛制共用的聚合结果，同分并列且 ID 只稳定展示顺序。 */
export interface ContestScoreRow {
  user_id: string;
  rank: number;
  total_score: number;
  solved: number;
  penalty_ms: number;
  pending: boolean;
  last_improvement_at: string | null;
  problems: ContestScoreCell[];
}

/** 赛制允许题型，在创建和编辑阶段共用。 */
export function contestAllowsProblem(
  type: ContestType,
  kind: ContestScoreProblem["kind"],
): boolean {
  if (type === "kaggle") return kind === "ai" || kind === "objective";
  if (type === "oi") return kind === "oi" || kind === "objective";
  return kind === "oi";
}

/** 所有满分换算共用整数四舍五入，客观题不参与题目权重换算。 */
export function weightedContestScore(
  rawScore: number,
  problem: ContestScoreProblem,
): number {
  if (problem.kind === "objective") return rawScore;
  return Number(
    (BigInt(rawScore) * BigInt(problem.max_score) + 5000n) / 10000n,
  );
}

function receiptOrder(
  a: ContestScoreSubmission,
  b: ContestScoreSubmission,
): number {
  const first = BigInt(a.receipt_sequence), second = BigInt(b.receipt_sequence);
  return first < second ? -1 : first > second ? 1 : a.id.localeCompare(b.id);
}

/** 纯计分引擎，调用方负责授权、正式判定及封榜截止视图的数据选择。 */
export function scoreContest(input: {
  type: ContestType;
  problems: readonly ContestScoreProblem[];
  participants: readonly string[];
  submissions: readonly ContestScoreSubmission[];
  start_time: string;
  end_time: string;
  penalty_minutes?: number;
}): ContestScoreRow[] {
  const start = Date.parse(input.start_time), end = Date.parse(input.end_time);
  const byUserProblem = new Map<
    string,
    Map<string, ContestScoreSubmission[]>
  >();
  for (const submission of input.submissions) {
    const received = Date.parse(submission.received_at);
    if (received < start || received > end) continue;
    const user = byUserProblem.get(submission.user_id) ?? new Map();
    const candidates = user.get(submission.problem_id) ?? [];
    candidates.push(submission);
    user.set(submission.problem_id, candidates);
    byUserProblem.set(submission.user_id, user);
  }
  const rows = input.participants.map((userId): ContestScoreRow => {
    let lastImprovement: string | null = null;
    const cells = input.problems.map((problem): ContestScoreCell => {
      const candidates = [...(byUserProblem.get(userId)?.get(problem.id) ?? [])]
        .sort(receiptOrder);
      const empty: ContestScoreCell = {
        problem_id: problem.id,
        submission_id: null,
        attempt_id: null,
        score: null,
        accepted: false,
        pending: false,
        attempts: candidates.length,
        penalty_ms: 0,
      };
      if (!candidates.length) return empty;
      if (input.type === "acm") {
        const acIndex = candidates.findIndex((s) =>
          s.state === "graded" && s.accepted
        );
        const before = acIndex < 0 ? candidates : candidates.slice(0, acIndex);
        const pending = before.some((s) => s.state !== "graded");
        const failures = before.filter((s) =>
          s.state === "graded" && !s.accepted &&
          s.verdict !== "CE" && s.verdict !== "CompileError" &&
          s.verdict !== "CompilationError"
        ).length;
        if (acIndex < 0) {
          return { ...empty, pending };
        }
        const accepted = candidates[acIndex];
        return {
          ...empty,
          submission_id: accepted.id,
          attempt_id: accepted.attempt_id,
          score: problem.max_score,
          accepted: true,
          pending,
          penalty_ms: Date.parse(accepted.received_at) - start +
            failures * (input.penalty_minutes ?? 20) * 60_000,
        };
      }
      let chosen: ContestScoreSubmission;
      if (input.type === "kaggle") {
        const graded = candidates.filter((s) => s.state === "graded");
        if (!graded.length) return { ...empty, pending: true };
        chosen = graded[0];
        let best = -1;
        for (const candidate of graded) {
          if (candidate.score! > best) {
            best = candidate.score!;
            chosen = candidate;
            if (
              lastImprovement === null ||
              candidate.received_at > lastImprovement
            ) {
              lastImprovement = candidate.received_at;
            }
          }
        }
      } else {
        chosen = candidates[candidates.length - 1];
        if (chosen.state !== "graded") {
          return {
            ...empty,
            submission_id: chosen.id,
            attempt_id: chosen.attempt_id,
            pending: true,
          };
        }
      }
      return {
        ...empty,
        submission_id: chosen.id,
        attempt_id: chosen.attempt_id,
        score: weightedContestScore(chosen.score!, problem),
        accepted: chosen.accepted,
        pending: input.type === "kaggle" &&
          candidates.some((s) => s.state !== "graded"),
      };
    });
    return {
      user_id: userId,
      rank: 0,
      problems: cells,
      total_score: cells.reduce((sum, c) => sum + (c.score ?? 0), 0),
      solved: cells.filter((c) => c.accepted).length,
      penalty_ms: cells.reduce((sum, c) => sum + c.penalty_ms, 0),
      pending: cells.some((c) => c.pending),
      last_improvement_at: lastImprovement,
    };
  });
  const compare = (a: ContestScoreRow, b: ContestScoreRow) => {
    if (input.type === "acm") {
      return b.solved - a.solved || a.penalty_ms - b.penalty_ms;
    }
    const score = b.total_score - a.total_score;
    if (score || input.type !== "kaggle") return score;
    return (a.last_improvement_at ?? "").localeCompare(
      b.last_improvement_at ?? "",
    );
  };
  rows.sort((a, b) => compare(a, b) || a.user_id.localeCompare(b.user_id));
  for (let i = 0; i < rows.length; i++) {
    rows[i].rank = i && compare(rows[i - 1], rows[i]) === 0
      ? rows[i - 1].rank
      : i + 1;
  }
  return rows;
}
