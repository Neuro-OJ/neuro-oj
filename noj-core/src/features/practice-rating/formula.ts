/**
 * 练习能力值（Best-N Practice Rating）纯函数公式（issue #810）。
 *
 * 设计要点：
 * - 单题满分潜能 B(d) = 50 + 2*d + 0.025*d^2（d ∈ [0, 100]，对应 50..500 分）：
 *   easy(25) ≈ 116、medium(50) ≈ 213、hard(75) ≈ 341、顶难(100) = 500。
 * - 得分率非线性系数 r^1.5（r = clamp(score / fullScore, 0, 1)）：
 *   适配 AI/预测/LLM 连续分制，刷新更高分即单调增分，同时鼓励冲击高分/满分。
 * - 单题能力分 problem_rating = floor(B(d) * r^1.5 + 0.5)（严格 half-up，与 SQL 口径一致）。
 * - 总能力值 = 官方主域公开题库中单题分最高的 Top 30（Best-N）题目之和（0..15000）。
 *   凑满 30 题后，低难度水题无法挤进 B30，天然防刷水题。
 */
import {
  PRACTICE_RATING_TOP_N,
  type PracticeRatingTier,
} from "../../shared/api-contracts/features.ts";

/** 出题人三档难度的先验映射（与 `knowledge/difficulty.ts` 口径一致）。 */
export const DIFFICULTY_TIER_PRIOR: Readonly<Record<string, number>> = Object
  .freeze({
    easy: 25,
    medium: 50,
    hard: 75,
  });

/** 客观题单小题记分单位（与 FULL_SCORE=10000 口径一致）。 */
export const OBJECTIVE_QUESTION_SCORE_UNIT = 100;

/** 将出题人三档难度映射为 0–100 先验分（未知值回退 medium=50）。 */
export function difficultyTierToPrior(tier: string | null | undefined): number {
  if (!tier) return DIFFICULTY_TIER_PRIOR.medium;
  return DIFFICULTY_TIER_PRIOR[tier] ?? DIFFICULTY_TIER_PRIOR.medium;
}

/** 限制难度分在 [0, 100] 范围内。 */
export function clampDifficulty(difficulty: number): number {
  if (!Number.isFinite(difficulty)) return DIFFICULTY_TIER_PRIOR.medium;
  return Math.min(100, Math.max(0, difficulty));
}

/** 计算给定难度 d ∈ [0, 100] 的单题满分潜能 B(d) ∈ [50, 500]。 */
export function problemBasePotential(difficulty: number): number {
  const d = clampDifficulty(difficulty);
  return 50 + 2 * d + 0.025 * d * d;
}

/** 单题能力分计算结果。 */
export interface ProblemRatingCalculation {
  /** 0–1 得分率（保留 4 位小数） */
  scoreRatio: number;
  /** 0–500 整数单题能力分 */
  problemRating: number;
}

/**
 * 计算单题能力分。
 *
 * `score <= 0` 或 `fullScore <= 0` 返回 0，不进入 Best-N。
 */
export function computeProblemRating(input: {
  difficulty: number;
  score: number;
  fullScore: number;
}): ProblemRatingCalculation {
  if (
    !Number.isFinite(input.score) ||
    !Number.isFinite(input.fullScore) ||
    input.score <= 0 ||
    input.fullScore <= 0
  ) {
    return { scoreRatio: 0, problemRating: 0 };
  }
  const rawRatio = Math.min(1, Math.max(0, input.score / input.fullScore));
  const rawRating = problemBasePotential(input.difficulty) *
    Math.pow(rawRatio, 1.5);
  // 对非负数使用 Math.floor(x + 0.5) 与 SQL `floor(val + 0.5)::int` 严格对齐。
  const problemRating = Math.floor(rawRating + 0.5);
  const scoreRatio = Math.round(rawRatio * 10000) / 10000;
  return { scoreRatio, problemRating };
}

/** 根据总练习能力值（0–15000）判定段位。 */
export function resolvePracticeRatingTier(rating: number): PracticeRatingTier {
  if (!Number.isFinite(rating) || rating <= 0) return "unrated";
  if (rating < 2000) return "novice";
  if (rating < 4500) return "apprentice";
  if (rating < 7500) return "proficient";
  if (rating < 10500) return "expert";
  if (rating < 13000) return "master";
  return "grandmaster";
}

/** 参与 Best-N 排序与聚合的候选单题条目。 */
export interface PracticeRatingCandidate {
  problem_id: string;
  effective_difficulty: number;
  score_ratio: number;
  problem_rating: number;
  achieved_at: string;
}

/** Best-N 聚合结果。 */
export interface PracticeRatingAggregate<T extends PracticeRatingCandidate> {
  rating: number;
  tier: PracticeRatingTier;
  topN: number;
  countedProblems: number;
  totalScoredProblems: number;
  floorRating: number | null;
  topEntries: T[];
}

/**
 * 按确定性顺序选取 Best-N 并聚合总能力值。
 *
 * 排序优先级：
 * 1. problem_rating DESC
 * 2. effective_difficulty DESC
 * 3. score_ratio DESC
 * 4. achieved_at ASC（更早达成优先）
 * 5. problem_id ASC（最终稳定 tiebreaker）
 */
export function aggregatePracticeRating<T extends PracticeRatingCandidate>(
  candidates: readonly T[],
  topN: number = PRACTICE_RATING_TOP_N,
): PracticeRatingAggregate<T> {
  const positive = candidates.filter((item) => item.problem_rating > 0);
  const sorted = [...positive].sort((a, b) => {
    if (b.problem_rating !== a.problem_rating) {
      return b.problem_rating - a.problem_rating;
    }
    if (b.effective_difficulty !== a.effective_difficulty) {
      return b.effective_difficulty - a.effective_difficulty;
    }
    if (b.score_ratio !== a.score_ratio) {
      return b.score_ratio - a.score_ratio;
    }
    if (a.achieved_at !== b.achieved_at) {
      return a.achieved_at.localeCompare(b.achieved_at);
    }
    return a.problem_id.localeCompare(b.problem_id);
  });

  const topEntries = sorted.slice(0, topN);
  const rating = topEntries.reduce((sum, item) => sum + item.problem_rating, 0);
  const floorRating = topEntries.length >= topN
    ? topEntries[topN - 1].problem_rating
    : null;

  return {
    rating,
    tier: resolvePracticeRatingTier(rating),
    topN,
    countedProblems: topEntries.length,
    totalScoredProblems: positive.length,
    floorRating,
    topEntries,
  };
}
