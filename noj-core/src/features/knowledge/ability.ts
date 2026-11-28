/**
 * 知识图谱能力评估纯计算模块（无数据库依赖，确定性可单测）。
 *
 * 承载：
 * - 轻量级 Elo 能力分（0–100）与主/次知识点权重（primary=1.0, secondary=0.35）；
 * - 按题目去重的有效最高分聚合（防同一题重复提交刷分）；
 * - 有效加权证据量累计与防稀疏题库虚高的三态（none / learning / mastered）判定；
 * - 读时遗忘衰减（不写回数据库，按 `now - last_passed_at` 实时计算展示能力分与 `needs_review`）。
 */

/** 掌握状态三态（与表 `user_knowledge_mastery.state` 一致）。 */
export type MasteryState = "none" | "learning" | "mastered";

/** 题目—知识点挂载角色。 */
export type KnowledgeMappingRole = "primary" | "secondary";

/** 默认「已掌握」所需达标题数 K（与系统设置默认值一致）。 */
export const DEFAULT_MASTERY_MIN_SOLVED = 3;

/** 轻量级 Elo 参数。 */
export const INITIAL_ABILITY = 25;
export const ELO_SCALE = 25;
export const ELO_K0 = 32;
export const ELO_ALPHA = 0.2;

/** 主/次知识点权重。 */
export const ROLE_WEIGHT_PRIMARY = 1.0;
export const ROLE_WEIGHT_SECONDARY = 0.35;

/** 未达标有效尝试计入证据量的折算系数（避免靠反复失败虚增证据量）。 */
export const ATTEMPT_EVIDENCE_FACTOR = 0.25;

/** 常规与稀疏节点的 mastered 能力/证据收敛阈值。 */
export const MASTERED_MIN_ABILITY = 45;
export const SPARSE_MASTERED_MIN_EVIDENCE = 1.5;
/** 稀疏节点单题攻克高难题放行阈值（对齐 `tierOf(d) === 'hard'` 的 67）。 */
export const SPARSE_HARD_DIFFICULTY = 67;
export const SPARSE_HARD_MIN_ABILITY = 50;

/** 读时遗忘衰减参数（零后台全表写库）。 */
export const DECAY_GRACE_DAYS = 60;
export const DECAY_HALF_LIFE_DAYS = 180;
export const DECAY_FLOOR_RATIO = 0.65;
export const REVIEW_TRIGGER_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 夹紧数值到 `[min, max]`。 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 挂载角色对应的更新与证据权重。 */
export function roleWeightOf(role: KnowledgeMappingRole): number {
  return role === "primary" ? ROLE_WEIGHT_PRIMARY : ROLE_WEIGHT_SECONDARY;
}

/**
 * 连续得分率 `y ∈ [0, 1]`（沿用 `difficulty.ts` 与 `objective-full-score.ts` 口径）。
 *
 * 非客观题满分固定 `10000`；客观题套卷满分为 `min(10000, full_score ?? 10000)`。
 */
export function computeScoreRatio(
  score: number | null,
  options: {
    is_objective: boolean;
    full_score?: number | null;
    full_score_default?: number;
  },
): number {
  if (score === null || !Number.isFinite(score) || score <= 0) return 0;
  const maxDefault = options.full_score_default ?? 10000;
  const full = options.is_objective
    ? Math.min(maxDefault, options.full_score ?? maxDefault)
    : maxDefault;
  if (!Number.isFinite(full) || full <= 0) return 0;
  return clamp(score / full, 0, 1);
}

/** 预期得分率 $E = 1 / (1 + 10^{(d - \theta) / 25})$。 */
export function expectedScore(ability: number, difficulty: number): number {
  const exponent = (difficulty - ability) / ELO_SCALE;
  return 1 / (1 + Math.pow(10, exponent));
}

/** 自适应步长 $K(w) = K_0 / (1 + \alpha w)$。 */
export function adaptiveStep(evidenceWeight: number): number {
  const w = Math.max(0, Number.isFinite(evidenceWeight) ? evidenceWeight : 0);
  return ELO_K0 / (1 + ELO_ALPHA * w);
}

/** 难度三分位上界（不含）：上三分之一为 `>=` 此值。 */
export function upperThirdThreshold(difficulties: readonly number[]): number {
  if (difficulties.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...difficulties].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length * 2) / 3)]!;
}

/** 单次题目作答观测（用于节点能力分重算）。 */
export interface ProblemAbilityObservation {
  problem_id: string;
  role: KnowledgeMappingRole;
  /** 题目校准难度（0–100；无校准行回退先验）。 */
  difficulty: number;
  /** 连续得分率 `y ∈ [0, 1]`。 */
  score_ratio: number;
  /** 是否达到该题及格线（沿用 `isPassingScore` 口径）。 */
  passed: boolean;
  /** 首次达到该题最高分的作答时间（ISO 字符串；用于稳定的 Elo 重放顺序）。 */
  attempted_at?: string | null;
  /** 该题最近一次达标作答时间（ISO 字符串；独立于最高分时间，供遗忘衰减使用）。 */
  last_passed_at?: string | null;
}

/** 节点能力分计算结果。 */
export interface NodeAbilitySummary {
  /** 0–100 整数能力分（无有效作答时为 0）。 */
  ability_score: number;
  /** 累计有效加权证据量（保留 2 位小数，非负）。 */
  evidence_weight: number;
  /** 仅达标题目累计的加权证据量（保留 2 位小数，非负）。 */
  passed_weight: number;
  /** 最近一次达标时间（ISO 字符串，无达标为空）。 */
  last_passed_at: string | null;
  /** 去重后的有效观测数。 */
  distinct_problems: number;
}

function parseTimestampMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function earlierTimestamp(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  const aMs = parseTimestampMs(a);
  const bMs = parseTimestampMs(b);
  if (aMs !== null && bMs !== null) return aMs <= bMs ? a! : b!;
  if (aMs !== null) return a!;
  if (bMs !== null) return b!;
  return a ?? b ?? null;
}

function laterTimestamp(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  const aMs = parseTimestampMs(a);
  const bMs = parseTimestampMs(b);
  if (aMs !== null && bMs !== null) return aMs >= bMs ? a! : b!;
  if (aMs !== null) return a!;
  if (bMs !== null) return b!;
  return a ?? b ?? null;
}

/**
 * 按题目去重防刷分：同一题保留最高得分率；得分率相同时优先 `primary` 与 `passed`，
 * 最高分对应时间保留较早一次（保证重复刷同分不改变 Elo 重放顺序），同时独立追踪
 * 最新一次达标时间 `last_passed_at` 供遗忘衰减使用。
 */
export function deduplicateObservations(
  observations: readonly ProblemAbilityObservation[],
): ProblemAbilityObservation[] {
  const byProblem = new Map<string, ProblemAbilityObservation>();
  for (const raw of observations) {
    const passed = Boolean(raw.passed);
    const normalized: ProblemAbilityObservation = {
      problem_id: raw.problem_id,
      role: raw.role,
      difficulty: clamp(raw.difficulty, 0, 100),
      score_ratio: clamp(raw.score_ratio, 0, 1),
      passed,
      attempted_at: raw.attempted_at ?? null,
      last_passed_at: raw.last_passed_at ??
        (passed ? (raw.attempted_at ?? null) : null),
    };
    const prev = byProblem.get(normalized.problem_id);
    if (!prev) {
      byProblem.set(normalized.problem_id, normalized);
      continue;
    }
    const role: KnowledgeMappingRole =
      prev.role === "primary" || normalized.role === "primary"
        ? "primary"
        : "secondary";
    const mergedPassed = prev.passed || normalized.passed;
    const betterScore = normalized.score_ratio > prev.score_ratio;
    const tiedScore = normalized.score_ratio === prev.score_ratio;
    const chosen = betterScore ? normalized : prev;
    // 得分未提升时保持首次达到最高分的时间，避免重复刷题导致 Elo 重放顺序漂移。
    const attemptedAt = betterScore
      ? normalized.attempted_at ?? null
      : tiedScore
      ? earlierTimestamp(prev.attempted_at, normalized.attempted_at)
      : prev.attempted_at ?? null;
    // 达标时间独立取最新值，让复习通过（哪怕低于历史最高分）也能刷新遗忘时钟。
    const lastPassedAt = laterTimestamp(
      prev.last_passed_at,
      normalized.last_passed_at,
    );
    byProblem.set(normalized.problem_id, {
      problem_id: normalized.problem_id,
      role,
      difficulty: chosen.difficulty,
      score_ratio: Math.max(prev.score_ratio, normalized.score_ratio),
      passed: mergedPassed,
      attempted_at: attemptedAt,
      last_passed_at: lastPassedAt,
    });
  }

  return [...byProblem.values()].sort((a, b) => {
    const aMs = parseTimestampMs(a.attempted_at);
    const bMs = parseTimestampMs(b.attempted_at);
    if (aMs !== null && bMs !== null && aMs !== bMs) return aMs - bMs;
    if (aMs !== null && bMs === null) return -1;
    if (aMs === null && bMs !== null) return 1;
    return a.problem_id < b.problem_id
      ? -1
      : a.problem_id > b.problem_id
      ? 1
      : 0;
  });
}

function roundWeight(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

/**
 * 基于去重后的有效作答序列计算节点轻量级 Elo 能力分与加权证据量。
 */
export function computeNodeAbility(
  observations: readonly ProblemAbilityObservation[],
): NodeAbilitySummary {
  const deduped = deduplicateObservations(observations);
  if (deduped.length === 0) {
    return {
      ability_score: 0,
      evidence_weight: 0,
      passed_weight: 0,
      last_passed_at: null,
      distinct_problems: 0,
    };
  }

  let theta = INITIAL_ABILITY;
  let evidenceWeight = 0;
  let passedWeight = 0;
  let lastPassedAt: string | null = null;
  let lastPassedMs: number | null = null;

  for (const obs of deduped) {
    const wRole = roleWeightOf(obs.role);
    const expected = expectedScore(theta, obs.difficulty);
    const step = adaptiveStep(evidenceWeight);
    theta = clamp(theta + step * wRole * (obs.score_ratio - expected), 0, 100);

    if (obs.passed) {
      evidenceWeight += wRole;
      passedWeight += wRole;
      const passTime = obs.last_passed_at ?? obs.attempted_at ?? null;
      const ms = parseTimestampMs(passTime);
      if (ms !== null) {
        if (lastPassedMs === null || ms > lastPassedMs) {
          lastPassedMs = ms;
          lastPassedAt = passTime!;
        }
      } else if (lastPassedAt === null && passTime) {
        lastPassedAt = passTime;
      }
    } else {
      evidenceWeight += wRole * ATTEMPT_EVIDENCE_FACTOR;
    }
  }

  return {
    ability_score: Math.round(clamp(theta, 0, 100)),
    evidence_weight: roundWeight(evidenceWeight),
    passed_weight: roundWeight(passedWeight),
    last_passed_at: lastPassedAt,
    distinct_problems: deduped.length,
  };
}

/** 单节点掌握度计算的输入（纯函数；兼容旧字段并可选传入完整作答观测）。 */
export interface NodeMasteryInput {
  /** 节点作为主知识点的题目数（同一可统计口径；含未达标题）。 */
  total: number;
  /** 用户主知识点达标题的难度分（校准难度；无校准行用先验）。 */
  passed_difficulties: readonly number[];
  /** 节点全部主知识点题目（含未达标）的难度分。 */
  difficulties: readonly number[];
  solved_count: number;
  attempted_count: number;
  failed_attempts: number;
  /** 可选：含主/次知识点与连续得分率、作答时间的完整观测；缺省时由 `passed_difficulties` 合成。 */
  observations?: readonly ProblemAbilityObservation[];
}

/** 单节点掌握度计算结果（向后兼容旧五字段，并扩展能力分与证据量）。 */
export interface NodeMasteryResult {
  state: MasteryState;
  solved_count: number;
  attempted_count: number;
  failed_attempts: number;
  max_passed_difficulty: number | null;
  ability_score: number;
  evidence_weight: number;
  last_passed_at: string | null;
}

/**
 * 掌握度判定（纯函数）。
 *
 * - 保持 `solved_count` / `attempted_count` / `failed_attempts` 主知识点统计口径；
 * - 无主知识点达标 → `none`（仅次要知识点贡献只累积 `ability_score` 与 `evidence_weight`，不污染班级矩阵状态）；
 * - 常规题库（`total >= K`）：`passed_weight >= K`（主/次加权达标证据足）且至少一道主达标题位于上三分之一，
 *   且 `ability_score >= MASTERED_MIN_ABILITY`（45）→ `mastered`；
 * - 稀疏题库（`0 < total < K`）：须全部主知识点题达标，且满足以下任一条件方判 `mastered`（防止做对 1 道简单题虚高）：
 *   1. 有效达标证据 `passed_weight >= SPARSE_MASTERED_MIN_EVIDENCE`（1.5）且 `ability_score >= 45`；
 *   2. 已攻克高难题（`max_passed_difficulty >= 67`）且 `ability_score >= 50`。
 */
export function computeNodeMastery(
  input: NodeMasteryInput,
  minSolved: number = DEFAULT_MASTERY_MIN_SOLVED,
): NodeMasteryResult {
  const solved = Math.max(0, input.passed_difficulties.length);
  const total = Math.max(0, input.total);
  const maxPassed = solved > 0 ? Math.max(...input.passed_difficulties) : null;

  const observations: readonly ProblemAbilityObservation[] =
    input.observations ??
      input.passed_difficulties.map((difficulty, idx) => ({
        problem_id: `synthetic-${idx}`,
        role: "primary" as const,
        difficulty,
        score_ratio: 1,
        passed: true,
        attempted_at: null,
      }));

  const ability = computeNodeAbility(observations);

  let mastered = false;
  if (solved > 0 && total > 0) {
    if (total < minSolved) {
      const allPrimarySolved = solved >= total;
      const enoughSparseEvidence =
        ability.passed_weight >= SPARSE_MASTERED_MIN_EVIDENCE &&
        ability.ability_score >= MASTERED_MIN_ABILITY;
      const conqueredHard = maxPassed !== null &&
        maxPassed >= SPARSE_HARD_DIFFICULTY &&
        ability.ability_score >= SPARSE_HARD_MIN_ABILITY;
      mastered = allPrimarySolved && (enoughSparseEvidence || conqueredHard);
    } else {
      const threshold = upperThirdThreshold(input.difficulties);
      const hasHard = input.passed_difficulties.some((d) => d >= threshold);
      mastered = ability.passed_weight >= minSolved &&
        hasHard &&
        ability.ability_score >= MASTERED_MIN_ABILITY;
    }
  }

  return {
    state: mastered ? "mastered" : solved > 0 ? "learning" : "none",
    solved_count: input.solved_count,
    attempted_count: input.attempted_count,
    failed_attempts: input.failed_attempts,
    max_passed_difficulty: maxPassed,
    ability_score: ability.ability_score,
    evidence_weight: ability.evidence_weight,
    last_passed_at: ability.last_passed_at,
  };
}

/** 读时遗忘衰减计算结果（实时派生，不写回数据库）。 */
export interface DecayedAbilityView {
  ability_score: number;
  effective_ability: number;
  needs_review: boolean;
  days_since_pass: number | null;
}

/**
 * 读时遗忘衰减（纯函数）：
 *
 * - 距 `last_passed_at` ≤ 60 天：无衰减，`needs_review = false`；
 * - 超过 60 天：按半衰期 180 天温和指数衰减，保留下限 65%（`DECAY_FLOOR_RATIO`）；
 * - 距 `last_passed_at` ≥ 90 天且节点处于 `learning`/`mastered` 且 `ability_score > 0`：
 *   标记 `needs_review = true`。
 */
export function applyForgettingDecay(
  input: {
    ability_score: number;
    state: MasteryState;
    last_passed_at: string | null;
  },
  now: Date = new Date(),
): DecayedAbilityView {
  const base = Math.round(clamp(input.ability_score, 0, 100));
  const passedMs = parseTimestampMs(input.last_passed_at);
  if (passedMs === null || base <= 0) {
    return {
      ability_score: base,
      effective_ability: base,
      needs_review: false,
      days_since_pass: null,
    };
  }
  const elapsedMs = Math.max(0, now.getTime() - passedMs);
  const elapsedDays = elapsedMs / MS_PER_DAY;
  let effective = base;
  if (elapsedDays > DECAY_GRACE_DAYS) {
    const overdue = elapsedDays - DECAY_GRACE_DAYS;
    const factor = Math.max(
      DECAY_FLOOR_RATIO,
      Math.pow(2, -overdue / DECAY_HALF_LIFE_DAYS),
    );
    effective = Math.round(clamp(base * factor, 0, 100));
  }
  const needsReview =
    (input.state === "mastered" || input.state === "learning") &&
    elapsedDays >= REVIEW_TRIGGER_DAYS;
  return {
    ability_score: base,
    effective_ability: effective,
    needs_review: needsReview,
    days_since_pass: Math.floor(elapsedDays),
  };
}
