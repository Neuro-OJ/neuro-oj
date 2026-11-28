import { assertEquals } from "jsr:@std/assert@^1";
import {
  aggregatePracticeRating,
  clampDifficulty,
  computeProblemRating,
  difficultyTierToPrior,
  problemBasePotential,
  resolvePracticeRatingTier,
} from "../formula.ts";

Deno.test("practice-rating formula: 难度先验与单题满分潜能", () => {
  assertEquals(difficultyTierToPrior("easy"), 25);
  assertEquals(difficultyTierToPrior("medium"), 50);
  assertEquals(difficultyTierToPrior("hard"), 75);
  assertEquals(difficultyTierToPrior("unknown"), 50);
  assertEquals(difficultyTierToPrior(null), 50);

  assertEquals(clampDifficulty(-10), 0);
  assertEquals(clampDifficulty(150), 100);
  assertEquals(clampDifficulty(Number.NaN), 50);

  assertEquals(problemBasePotential(0), 50);
  assertEquals(problemBasePotential(25), 115.625);
  assertEquals(problemBasePotential(50), 212.5);
  assertEquals(problemBasePotential(75), 340.625);
  assertEquals(problemBasePotential(100), 500);
});

Deno.test("practice-rating formula: 连续分制、0分过滤与客观题口径", () => {
  // 0 分或非法满分均记 0
  assertEquals(
    computeProblemRating({ difficulty: 75, score: 0, fullScore: 10000 }),
    { scoreRatio: 0, problemRating: 0 },
  );
  assertEquals(
    computeProblemRating({ difficulty: 75, score: 5000, fullScore: 0 }),
    { scoreRatio: 0, problemRating: 0 },
  );

  // 满分与部分得分单调递增（模拟 AI 题从 50% -> 80% -> 95% -> 100%）
  const p50 = computeProblemRating({
    difficulty: 50,
    score: 5000,
    fullScore: 10000,
  });
  const p80 = computeProblemRating({
    difficulty: 50,
    score: 8000,
    fullScore: 10000,
  });
  const p95 = computeProblemRating({
    difficulty: 50,
    score: 9500,
    fullScore: 10000,
  });
  const p100 = computeProblemRating({
    difficulty: 50,
    score: 10000,
    fullScore: 10000,
  });
  assertEquals(p50.problemRating, 75);
  assertEquals(p80.problemRating, 152);
  assertEquals(p95.problemRating, 197);
  assertEquals(p100.problemRating, 213);
  assertEquals(p50.problemRating < p80.problemRating, true);
  assertEquals(p80.problemRating < p95.problemRating, true);
  assertEquals(p95.problemRating < p100.problemRating, true);

  // 客观题套卷（3 小题满分 300，答对 2 题得 200）
  const obj = computeProblemRating({
    difficulty: 60,
    score: 200,
    fullScore: 300,
  });
  assertEquals(obj.scoreRatio, 0.6667);
  assertEquals(
    obj.problemRating,
    Math.floor(problemBasePotential(60) * Math.pow(2 / 3, 1.5) + 0.5),
  );
});

Deno.test("practice-rating formula: 段位边界与 Best-N 防刷水题", () => {
  assertEquals(resolvePracticeRatingTier(0), "unrated");
  assertEquals(resolvePracticeRatingTier(1), "novice");
  assertEquals(resolvePracticeRatingTier(1999), "novice");
  assertEquals(resolvePracticeRatingTier(2000), "apprentice");
  assertEquals(resolvePracticeRatingTier(4500), "proficient");
  assertEquals(resolvePracticeRatingTier(7500), "expert");
  assertEquals(resolvePracticeRatingTier(10500), "master");
  assertEquals(resolvePracticeRatingTier(13000), "grandmaster");

  // 未满 30 题：floorRating 为 null
  const partial = aggregatePracticeRating([
    {
      problem_id: "p1",
      effective_difficulty: 50,
      score_ratio: 1,
      problem_rating: 213,
      achieved_at: "2026-11-01T00:00:00Z",
    },
    {
      problem_id: "p2",
      effective_difficulty: 75,
      score_ratio: 1,
      problem_rating: 341,
      achieved_at: "2026-11-02T00:00:00Z",
    },
  ]);
  assertEquals(partial.rating, 554);
  assertEquals(partial.countedProblems, 2);
  assertEquals(partial.totalScoredProblems, 2);
  assertEquals(partial.floorRating, null);
  assertEquals(partial.topEntries[0].problem_id, "p2");

  // 满 30 题后再加低分水题：总分不变、floorRating 生效
  const hard30 = Array.from({ length: 30 }, (_, idx) => ({
    problem_id: `hard-${String(idx).padStart(2, "0")}`,
    effective_difficulty: 75,
    score_ratio: 1,
    problem_rating: 341,
    achieved_at: "2026-11-01T00:00:00Z",
  }));
  const withEasy = [
    ...hard30,
    {
      problem_id: "easy-water",
      effective_difficulty: 25,
      score_ratio: 1,
      problem_rating: 116,
      achieved_at: "2026-11-02T00:00:00Z",
    },
  ];
  const full = aggregatePracticeRating(withEasy);
  assertEquals(full.countedProblems, 30);
  assertEquals(full.totalScoredProblems, 31);
  assertEquals(full.rating, 30 * 341);
  assertEquals(full.floorRating, 341);
  assertEquals(full.tier, "expert");
  assertEquals(
    full.topEntries.some((entry) => entry.problem_id === "easy-water"),
    false,
  );
});
