/**
 * 练习能力值（Best-N Practice Rating）功能对外出口（见 README.md）。
 *
 * 其他功能与旧模块只能从这里引用能力值查询能力；本目录内部文件互相直接引用。
 */
import { defineFeature } from "../../shared/feature.ts";
import { practiceRatingRouter } from "./routes.ts";

export const feature = defineFeature({
  name: "practice-rating",
  router: practiceRatingRouter,
});

export {
  aggregatePracticeRating,
  clampDifficulty,
  computeProblemRating,
  DIFFICULTY_TIER_PRIOR,
  difficultyTierToPrior,
  OBJECTIVE_QUESTION_SCORE_UNIT,
  type PracticeRatingAggregate,
  type PracticeRatingCandidate,
  problemBasePotential,
  type ProblemRatingCalculation,
  resolvePracticeRatingTier,
} from "./formula.ts";

export {
  getPracticeRatingLeaderboard,
  getUserPracticeRating,
} from "./service.ts";

export {
  PRACTICE_RATING_FORMULA_VERSION,
  PRACTICE_RATING_TOP_N,
  type PracticeRatingEntry,
  type PracticeRatingLeaderboard,
  type PracticeRatingLeaderboardRow,
  type PracticeRatingTier,
  type UserPracticeRating,
} from "../../shared/api-contracts/features.ts";
