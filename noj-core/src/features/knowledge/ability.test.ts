/**
 * 知识图谱能力评估纯函数单测（无数据库依赖，可由 `test:logic` / `test:domain knowledge` 直接运行）。
 *
 * 覆盖：连续得分率差异、难题/水题涨幅差异、主/次知识点权重、同题去重防刷分、
 * 稀疏题库防虚高与高难题放行、常规题库协同达标、读时遗忘衰减与边界值。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  adaptiveStep,
  applyForgettingDecay,
  computeNodeAbility,
  computeNodeMastery,
  computeScoreRatio,
  DECAY_FLOOR_RATIO,
  DECAY_GRACE_DAYS,
  deduplicateObservations,
  ELO_K0,
  expectedScore,
  INITIAL_ABILITY,
  MASTERED_MIN_ABILITY,
  type ProblemAbilityObservation,
  REVIEW_TRIGGER_DAYS,
  ROLE_WEIGHT_PRIMARY,
  ROLE_WEIGHT_SECONDARY,
  roleWeightOf,
  SPARSE_HARD_DIFFICULTY,
  upperThirdThreshold,
} from "./ability.ts";

Deno.test("ability: 连续得分率与预期得分/步长公式", () => {
  // 非客观题按 10000 满分线性归一，越界夹紧。
  assertEquals(computeScoreRatio(null, { is_objective: false }), 0);
  assertEquals(computeScoreRatio(-100, { is_objective: false }), 0);
  assertEquals(computeScoreRatio(6000, { is_objective: false }), 0.6);
  assertEquals(computeScoreRatio(9800, { is_objective: false }), 0.98);
  assertEquals(computeScoreRatio(12000, { is_objective: false }), 1);

  // 客观题套卷按小题数 × 100 满分归一。
  assertEquals(
    computeScoreRatio(300, { is_objective: true, full_score: 500 }),
    0.6,
  );
  assertEquals(
    computeScoreRatio(500, { is_objective: true, full_score: 500 }),
    1,
  );
  assertEquals(
    computeScoreRatio(500, { is_objective: true, full_score: 0 }),
    0,
  );

  // d === theta 时预期得分率为 0.5；题越难预期越低。
  assertEquals(expectedScore(50, 50), 0.5);
  assert(expectedScore(50, 75) < 0.15);
  assert(expectedScore(50, 25) > 0.85);

  // 自适应步长随证据量单调递减，负值按 0 兜底。
  assertEquals(adaptiveStep(0), ELO_K0);
  assertEquals(adaptiveStep(-5), ELO_K0);
  assert(adaptiveStep(2) < adaptiveStep(0));
  assert(adaptiveStep(6) < adaptiveStep(2));

  assertEquals(roleWeightOf("primary"), ROLE_WEIGHT_PRIMARY);
  assertEquals(roleWeightOf("secondary"), ROLE_WEIGHT_SECONDARY);
});

Deno.test("ability: 连续得分差异（60 分险过 vs 98 分高分）与难题/水题涨幅差异", () => {
  const barely = computeNodeAbility([
    {
      problem_id: "p1",
      role: "primary",
      difficulty: 50,
      score_ratio: 0.6,
      passed: true,
      attempted_at: "2026-10-01T00:00:00.000Z",
    },
  ]);
  const high = computeNodeAbility([
    {
      problem_id: "p1",
      role: "primary",
      difficulty: 50,
      score_ratio: 0.98,
      passed: true,
      attempted_at: "2026-10-01T00:00:00.000Z",
    },
  ]);
  assert(
    high.ability_score > barely.ability_score + 8,
    `高分能力分(${high.ability_score})应明显高于险过(${barely.ability_score})`,
  );

  const easySolve = computeNodeAbility([
    {
      problem_id: "p-easy",
      role: "primary",
      difficulty: 15,
      score_ratio: 1,
      passed: true,
      attempted_at: "2026-10-01T00:00:00.000Z",
    },
  ]);
  const hardSolve = computeNodeAbility([
    {
      problem_id: "p-hard",
      role: "primary",
      difficulty: 80,
      score_ratio: 1,
      passed: true,
      attempted_at: "2026-10-01T00:00:00.000Z",
    },
  ]);
  assert(
    hardSolve.ability_score - INITIAL_ABILITY >
      (easySolve.ability_score - INITIAL_ABILITY) * 2,
    `难题涨幅(${hardSolve.ability_score})应远高于水题(${easySolve.ability_score})`,
  );
});

Deno.test("ability: 主/次知识点权重差异与协同贡献", () => {
  const primaryOnly = computeNodeAbility([
    {
      problem_id: "p1",
      role: "primary",
      difficulty: 60,
      score_ratio: 1,
      passed: true,
      attempted_at: "2026-10-01T00:00:00.000Z",
    },
  ]);
  const secondaryOnly = computeNodeAbility([
    {
      problem_id: "p1",
      role: "secondary",
      difficulty: 60,
      score_ratio: 1,
      passed: true,
      attempted_at: "2026-10-01T00:00:00.000Z",
    },
  ]);
  assertEquals(primaryOnly.evidence_weight, 1);
  assertEquals(secondaryOnly.evidence_weight, 0.35);
  assert(secondaryOnly.ability_score > INITIAL_ABILITY);
  assert(primaryOnly.ability_score > secondaryOnly.ability_score);

  // 仅做次要知识点题（solved_count = 0）不会误标为 learning/mastered，但保留能力与证据。
  const secondaryMastery = computeNodeMastery({
    total: 3,
    passed_difficulties: [],
    difficulties: [20, 40, 60],
    solved_count: 0,
    attempted_count: 0,
    failed_attempts: 0,
    observations: [
      {
        problem_id: "s1",
        role: "secondary",
        difficulty: 70,
        score_ratio: 1,
        passed: true,
        attempted_at: "2026-10-01T00:00:00.000Z",
      },
    ],
  }, 3);
  assertEquals(secondaryMastery.state, "none");
  assertEquals(secondaryMastery.solved_count, 0);
  assertEquals(secondaryMastery.evidence_weight, 0.35);
  assert(secondaryMastery.ability_score > INITIAL_ABILITY);

  // 2 道主知识点（含上三分之一）+ 3 道次要知识点达标 → 加权证据 2 + 1.05 = 3.05 >= 3 → mastered。
  const synergy = computeNodeMastery({
    total: 4,
    passed_difficulties: [30, 65],
    difficulties: [20, 30, 50, 65],
    solved_count: 2,
    attempted_count: 2,
    failed_attempts: 0,
    observations: [
      {
        problem_id: "p1",
        role: "primary",
        difficulty: 30,
        score_ratio: 1,
        passed: true,
        attempted_at: "2026-10-01T00:00:00.000Z",
      },
      {
        problem_id: "p2",
        role: "primary",
        difficulty: 65,
        score_ratio: 0.95,
        passed: true,
        attempted_at: "2026-10-02T00:00:00.000Z",
      },
      {
        problem_id: "s1",
        role: "secondary",
        difficulty: 55,
        score_ratio: 1,
        passed: true,
        attempted_at: "2026-10-03T00:00:00.000Z",
      },
      {
        problem_id: "s2",
        role: "secondary",
        difficulty: 60,
        score_ratio: 0.9,
        passed: true,
        attempted_at: "2026-10-04T00:00:00.000Z",
      },
      {
        problem_id: "s3",
        role: "secondary",
        difficulty: 65,
        score_ratio: 0.95,
        passed: true,
        attempted_at: "2026-10-05T00:00:00.000Z",
      },
    ],
  }, 3);
  assertEquals(synergy.state, "mastered");
  assertEquals(synergy.evidence_weight, 3.05);
  assert(synergy.ability_score >= MASTERED_MIN_ABILITY);
});

Deno.test("ability: 同题去重防刷分（重复提交同一题不虚增能力分与证据量）", () => {
  const single: ProblemAbilityObservation[] = [
    {
      problem_id: "p1",
      role: "primary",
      difficulty: 60,
      score_ratio: 0.9,
      passed: true,
      attempted_at: "2026-10-05T00:00:00.000Z",
    },
  ];
  const spammed: ProblemAbilityObservation[] = [
    {
      problem_id: "p1",
      role: "primary",
      difficulty: 60,
      score_ratio: 0.4,
      passed: false,
      attempted_at: "2026-10-01T00:00:00.000Z",
    },
    {
      problem_id: "p1",
      role: "primary",
      difficulty: 60,
      score_ratio: 0.9,
      passed: true,
      attempted_at: "2026-10-02T00:00:00.000Z",
    },
    {
      problem_id: "p1",
      role: "primary",
      difficulty: 60,
      score_ratio: 0.9,
      passed: true,
      attempted_at: "2026-10-05T00:00:00.000Z",
    },
    {
      problem_id: "p1",
      role: "secondary",
      difficulty: 60,
      score_ratio: 0.8,
      passed: true,
      attempted_at: "2026-10-04T00:00:00.000Z",
    },
  ];

  const deduped = deduplicateObservations(spammed);
  assertEquals(deduped.length, 1);
  assertEquals(deduped[0]!.role, "primary");
  assertEquals(deduped[0]!.score_ratio, 0.9);
  assertEquals(deduped[0]!.attempted_at, "2026-10-02T00:00:00.000Z");
  assertEquals(deduped[0]!.last_passed_at, "2026-10-05T00:00:00.000Z");

  assertEquals(computeNodeAbility(spammed), computeNodeAbility(single));
});

Deno.test("ability: 同分重刷不改变 Elo 重放顺序，低分达标复习独立刷新 last_passed_at", () => {
  const base: ProblemAbilityObservation[] = [
    {
      problem_id: "p1",
      role: "primary",
      difficulty: 25,
      score_ratio: 0.6,
      passed: true,
      attempted_at: "2026-10-01T00:00:00.000Z",
    },
    {
      problem_id: "p2",
      role: "primary",
      difficulty: 50,
      score_ratio: 0.6,
      passed: true,
      attempted_at: "2026-10-02T00:00:00.000Z",
    },
    {
      problem_id: "p3",
      role: "primary",
      difficulty: 50,
      score_ratio: 0.6,
      passed: true,
      attempted_at: "2026-10-03T00:00:00.000Z",
    },
  ];
  const repeatedSameScore: ProblemAbilityObservation[] = [
    ...base,
    {
      problem_id: "p1",
      role: "primary",
      difficulty: 25,
      score_ratio: 0.6,
      passed: true,
      attempted_at: "2026-10-10T00:00:00.000Z",
    },
  ];
  const baseAbility = computeNodeAbility(base);
  const repeatedAbility = computeNodeAbility(repeatedSameScore);
  assertEquals(repeatedAbility.ability_score, baseAbility.ability_score);
  assertEquals(repeatedAbility.last_passed_at, "2026-10-10T00:00:00.000Z");

  const reviewedLowerScore = computeNodeAbility([
    {
      problem_id: "p1",
      role: "primary",
      difficulty: 60,
      score_ratio: 1,
      passed: true,
      attempted_at: "2026-06-01T00:00:00.000Z",
    },
    {
      problem_id: "p1",
      role: "primary",
      difficulty: 60,
      score_ratio: 0.7,
      passed: true,
      attempted_at: "2026-10-20T00:00:00.000Z",
    },
  ]);
  assertEquals(reviewedLowerScore.last_passed_at, "2026-10-20T00:00:00.000Z");
});

Deno.test("ability: 稀疏题库防虚高（单道简单题不判 mastered，攻克高难题或足量高分可判 mastered）", () => {
  // 1 道简单题（d=20）满分 → 停留在 learning，防虚高。
  const singleEasy = computeNodeMastery({
    total: 1,
    passed_difficulties: [20],
    difficulties: [20],
    solved_count: 1,
    attempted_count: 1,
    failed_attempts: 0,
    observations: [
      {
        problem_id: "p1",
        role: "primary",
        difficulty: 20,
        score_ratio: 1,
        passed: true,
        attempted_at: "2026-10-01T00:00:00.000Z",
      },
    ],
  }, 3);
  assertEquals(singleEasy.state, "learning");
  assertEquals(singleEasy.evidence_weight, 1);

  // 1 道高难题（d >= 67）高分通过 → 兼容稀疏节点高难放行 → mastered。
  const singleHard = computeNodeMastery({
    total: 1,
    passed_difficulties: [SPARSE_HARD_DIFFICULTY + 8],
    difficulties: [SPARSE_HARD_DIFFICULTY + 8],
    solved_count: 1,
    attempted_count: 1,
    failed_attempts: 0,
    observations: [
      {
        problem_id: "p-hard",
        role: "primary",
        difficulty: SPARSE_HARD_DIFFICULTY + 8,
        score_ratio: 0.95,
        passed: true,
        attempted_at: "2026-10-01T00:00:00.000Z",
      },
    ],
  }, 3);
  assertEquals(singleHard.state, "mastered");

  // 1 道高难题仅 60% 险过 → 能力分不足 50，仍为 learning。
  const singleHardBarely = computeNodeMastery({
    total: 1,
    passed_difficulties: [75],
    difficulties: [75],
    solved_count: 1,
    attempted_count: 1,
    failed_attempts: 0,
    observations: [
      {
        problem_id: "p-hard",
        role: "primary",
        difficulty: 75,
        score_ratio: 0.6,
        passed: true,
        attempted_at: "2026-10-01T00:00:00.000Z",
      },
    ],
  }, 3);
  assertEquals(singleHardBarely.state, "learning");

  // 2 道题均 60% 险过 → 能力分偏低，保持 learning；均满分 → mastered。
  const twoBarely = computeNodeMastery({
    total: 2,
    passed_difficulties: [20, 30],
    difficulties: [20, 30],
    solved_count: 2,
    attempted_count: 2,
    failed_attempts: 0,
    observations: [
      {
        problem_id: "p1",
        role: "primary",
        difficulty: 20,
        score_ratio: 0.6,
        passed: true,
      },
      {
        problem_id: "p2",
        role: "primary",
        difficulty: 30,
        score_ratio: 0.6,
        passed: true,
      },
    ],
  }, 3);
  assertEquals(twoBarely.state, "learning");

  const twoAced = computeNodeMastery({
    total: 2,
    passed_difficulties: [20, 30],
    difficulties: [20, 30],
    solved_count: 2,
    attempted_count: 2,
    failed_attempts: 0,
  }, 3);
  assertEquals(twoAced.state, "mastered");

  // 反复未达标尝试不能虚增 passed_weight 达到 mastered。
  const manyFails = computeNodeMastery({
    total: 3,
    passed_difficulties: [75],
    difficulties: [20, 40, 75],
    solved_count: 1,
    attempted_count: 5,
    failed_attempts: 4,
    observations: [
      {
        problem_id: "p1",
        role: "primary",
        difficulty: 75,
        score_ratio: 1,
        passed: true,
      },
      {
        problem_id: "f1",
        role: "primary",
        difficulty: 20,
        score_ratio: 0.2,
        passed: false,
      },
      {
        problem_id: "f2",
        role: "primary",
        difficulty: 30,
        score_ratio: 0.2,
        passed: false,
      },
      {
        problem_id: "f3",
        role: "primary",
        difficulty: 40,
        score_ratio: 0.2,
        passed: false,
      },
      {
        problem_id: "f4",
        role: "primary",
        difficulty: 50,
        score_ratio: 0.2,
        passed: false,
      },
    ],
  }, 3);
  assertEquals(manyFails.state, "learning");
});

Deno.test("ability: 读时遗忘衰减与待复习触发边界", () => {
  const base = new Date("2026-10-01T00:00:00.000Z");
  const afterDays = (days: number) =>
    new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

  // 宽限期内（0 天 / 60 天）无衰减、不触发待复习。
  const d0 = applyForgettingDecay(
    {
      ability_score: 80,
      state: "mastered",
      last_passed_at: base.toISOString(),
    },
    afterDays(0),
  );
  assertEquals(d0.effective_ability, 80);
  assertEquals(d0.needs_review, false);

  const dGrace = applyForgettingDecay(
    {
      ability_score: 80,
      state: "mastered",
      last_passed_at: base.toISOString(),
    },
    afterDays(DECAY_GRACE_DAYS),
  );
  assertEquals(dGrace.effective_ability, 80);
  assertEquals(dGrace.needs_review, false);

  // 超过宽限期但未满 90 天：温和衰减，尚不标记待复习。
  const d80 = applyForgettingDecay(
    {
      ability_score: 80,
      state: "mastered",
      last_passed_at: base.toISOString(),
    },
    afterDays(REVIEW_TRIGGER_DAYS - 10),
  );
  assert(d80.effective_ability < 80 && d80.effective_ability > 70);
  assertEquals(d80.needs_review, false);

  // 满 90 天：标记 needs_review = true。
  const d90 = applyForgettingDecay(
    {
      ability_score: 80,
      state: "mastered",
      last_passed_at: base.toISOString(),
    },
    afterDays(REVIEW_TRIGGER_DAYS),
  );
  assert(d90.effective_ability < 80);
  assertEquals(d90.needs_review, true);

  // 极长时间（365 天）受保底比例 65% 限制，不归零。
  const d365 = applyForgettingDecay(
    {
      ability_score: 80,
      state: "mastered",
      last_passed_at: base.toISOString(),
    },
    afterDays(365),
  );
  assertEquals(d365.effective_ability, Math.round(80 * DECAY_FLOOR_RATIO));
  assertEquals(d365.needs_review, true);

  // 边界：未来时间、非法时间、null、state=none、ability=0。
  assertEquals(
    applyForgettingDecay(
      {
        ability_score: 80,
        state: "mastered",
        last_passed_at: afterDays(10).toISOString(),
      },
      base,
    ).effective_ability,
    80,
  );
  assertEquals(
    applyForgettingDecay(
      { ability_score: 80, state: "mastered", last_passed_at: "not-a-date" },
      afterDays(200),
    ),
    {
      ability_score: 80,
      effective_ability: 80,
      needs_review: false,
      days_since_pass: null,
    },
  );
  assertEquals(
    applyForgettingDecay(
      { ability_score: 50, state: "none", last_passed_at: base.toISOString() },
      afterDays(200),
    ).needs_review,
    false,
  );
  assertEquals(
    applyForgettingDecay(
      {
        ability_score: 0,
        state: "mastered",
        last_passed_at: base.toISOString(),
      },
      afterDays(200),
    ).needs_review,
    false,
  );
});

Deno.test("ability: 边界值（空观测、极端分值夹紧、时间顺序确定性）", () => {
  assertEquals(computeNodeAbility([]), {
    ability_score: 0,
    evidence_weight: 0,
    passed_weight: 0,
    last_passed_at: null,
    distinct_problems: 0,
  });

  // 连续极低得分不会跌破 0；连续极高难题不会超过 100。
  const low = computeNodeAbility(
    Array.from({ length: 10 }, (_, i) => ({
      problem_id: `low-${i}`,
      role: "primary" as const,
      difficulty: 0,
      score_ratio: -0.5,
      passed: false,
    })),
  );
  assert(low.ability_score >= 0 && low.ability_score <= 100);

  const high = computeNodeAbility(
    Array.from({ length: 15 }, (_, i) => ({
      problem_id: `hi-${i}`,
      role: "primary" as const,
      difficulty: 100,
      score_ratio: 1.5,
      passed: true,
    })),
  );
  assert(high.ability_score >= 0 && high.ability_score <= 100);
  assert(high.ability_score > 80);

  // 时间戳不同顺序输入产生完全一致的确定性结果。
  const obsA: ProblemAbilityObservation[] = [
    {
      problem_id: "b",
      role: "primary",
      difficulty: 70,
      score_ratio: 1,
      passed: true,
      attempted_at: "2026-10-02T00:00:00.000Z",
    },
    {
      problem_id: "a",
      role: "primary",
      difficulty: 20,
      score_ratio: 0.7,
      passed: true,
      attempted_at: "2026-10-01T00:00:00.000Z",
    },
  ];
  assertEquals(
    computeNodeAbility(obsA),
    computeNodeAbility([...obsA].reverse()),
  );
  assertEquals(
    computeNodeAbility(obsA).last_passed_at,
    "2026-10-02T00:00:00.000Z",
  );

  assertEquals(upperThirdThreshold([60, 10, 50, 20, 40, 30]), 50);
  assertEquals(upperThirdThreshold([]), Number.POSITIVE_INFINITY);
});
