/**
 * 题目难度与「达标」判定（P2，见 design.md 第 7、8 节）。
 *
 * - 「达标」：有效得分 ≥ 题目及格线。有效成绩只取练习有效成绩
 *   （`submissions.effective_attempt_id` / `objective_submissions.effective_attempt_id`
 *   指向的评测尝试）与**已结束**比赛成绩；进行中比赛的提交不计入。
 *   客观题套卷及格线恒为满分（成绩按 ×100 记，即 10000）；其余题型为
 *   `problem_difficulty.pass_ratio_override ?? knowledge_pass_ratio` × 满分。
 * - 校准：`prior` 取 AI 打标难度（P1 未落库，暂用 `problems.difficulty` 三档映射
 *   easy 25 / medium 50 / hard 75）；`d_data = (1 − 达标人数 / 尝试人数) × 100`；
 *   `calibrated = round((k·prior + n·d_data) / (k + n))`，k = {@link PRIOR_STRENGTH}。
 * - 每日批量重算：由 `index.ts` 经 `defineFeature({ workers })` 注册的周期任务
 *   （24h，启动后不立即执行）驱动，多副本经 Postgres advisory lock 保证同一
 *   时刻只有一副本在算。
 *
 * 本模块同时供 P3 掌握度（`user_knowledge_mastery`）复用达标判定与难度派生。
 */
import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import type { UserActor } from "../../modules/access/contracts/actor.ts";
import {
  loadDomainProblemProtection,
  loadWorkspace,
} from "../../modules/access/index.ts";
import { getSetting } from "../../modules/platform/index.ts";
import { FULL_SCORE } from "../../shared/base/constants.ts";
import { logger } from "../../shared/base/logging.ts";
import { unwrapFirstRow, unwrapRows } from "../../shared/base/sql-rows.ts";
import { getDb } from "../../shared/db/connection.ts";
import type { DbRoot } from "../../shared/db/executor.ts";
import {
  domains,
  knowledgeNodes,
  problemDifficulty,
  problemKnowledge,
  problems,
} from "../../shared/db/schema.ts";
import type { ManagedTask } from "../../shared/runtime/managed-task.ts";
import { startPeriodicTask } from "../../shared/runtime/managed-task.ts";
import { objectiveFullScore } from "./objective-full-score.ts";

/** 难度三档（与 `problems.difficulty` 口径一致）。 */
export type DifficultyTier = "easy" | "medium" | "hard";

/** 出题人三档 → 0–100 先验映射（design.md 第 7 节）。 */
export const TIER_PRIOR: Readonly<Record<DifficultyTier, number>> = {
  easy: 25,
  medium: 50,
  hard: 75,
};

/** 先验强度 k：小样本时结果贴近先验。 */
export const PRIOR_STRENGTH = 20;

/** 达标默认及格线百分数（与注册表默认值一致）。 */
export const DEFAULT_PASS_RATIO = 60;

/** 单次批量重算的分批大小。 */
export const RECALIBRATE_BATCH_SIZE = 200;

/** 周期任务间隔：24 小时（启动后不立即执行）。 */
export const DIFFICULTY_RECALIBRATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 重算任务的 advisory lock 键（namespace 取 "NOJK" 十六进制）。 */
export const DIFFICULTY_RECALIBRATE_LOCK = {
  namespace: 0x4e4f4a4b,
  key: 1,
} as const;

/** 是否为合法三档。 */
export function isDifficultyTier(value: unknown): value is DifficultyTier {
  return value === "easy" || value === "medium" || value === "hard";
}

/** 三档 → 0–100 先验（未知值按 medium）。 */
export function tierToPrior(tier: string | null | undefined): number {
  return TIER_PRIOR[isDifficultyTier(tier) ? tier : "medium"];
}

/** 0–100 分数 → 三档展示（越大越难，与 `problems.difficulty` 同向）。 */
export function tierOf(calibrated: number): DifficultyTier {
  return calibrated < 34 ? "easy" : calibrated < 67 ? "medium" : "hard";
}

/** 读取配置的默认及格线百分数（越界时回退默认值）。 */
export function passRatio(): number {
  const raw = getSetting("knowledge_pass_ratio")?.value;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_PASS_RATIO;
  }
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/**
 * 题目及格分数（评测尝试的 ×100 记分口径，0–10000）。
 *
 * 客观题套卷恒为满分；其余题型 `override ?? knowledge_pass_ratio` × 满分。
 */
export function passScoreOf(input: {
  is_objective: boolean;
  pass_ratio_override: number | null;
}): number {
  if (input.is_objective) return FULL_SCORE;
  const ratio = input.pass_ratio_override ?? passRatio();
  return Math.round((FULL_SCORE * Math.min(100, Math.max(0, ratio))) / 100);
}

/** 达标判定参数。 */
export interface PassOption {
  is_objective: boolean;
  pass_ratio_override: number | null;
  /** 客观题套卷满分（小题数 × 100）；空时回退 {@link FULL_SCORE}。 */
  full_score?: number | null;
}

/** 题目及格分数（含客观题套卷满分），0–10000 记分口径。 */
export function resolvePassScore(input: PassOption): number {
  if (!input.is_objective) return passScoreOf(input);
  return Math.min(FULL_SCORE, input.full_score ?? FULL_SCORE);
}

/** 一次评测尝试的得分是否达标（`score` 为 ×100 记分，空视为 0）。 */
export function isPassingScore(
  score: number | null,
  input: PassOption,
): boolean {
  return (score ?? 0) >= resolvePassScore(input);
}

/** 校准计算（纯函数）：先验 + 数据信号加权。 */
export function calibrateDifficulty(
  prior: number,
  sampleSize: number,
  passedCount: number,
): { d_data: number; calibrated: number } {
  const n = Math.max(0, Math.trunc(sampleSize));
  const passed = Math.max(0, Math.min(n, Math.trunc(passedCount)));
  const dData = n === 0 ? 0 : (1 - passed / n) * 100;
  const calibrated = Math.round(
    (PRIOR_STRENGTH * prior + n * dData) / (PRIOR_STRENGTH + n),
  );
  return {
    d_data: Math.round(dData * 100) / 100,
    calibrated: Math.min(100, Math.max(0, calibrated)),
  };
}

/** 形如 `2026-01-01T00:00:00.000Z` 的赛期时间（与 access 合同同一口径）。 */
const CONTEST_TIME_REGEX =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

function idList(ids: string[]) {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `);
}

/**
 * 每题每用户的有效成绩（最高分），已排除进行中比赛。
 *
 * 版本口径已在投影时应用（`effective_attempt_id`）。比赛成绩只取已结束的
 * （`end_time` 可解析且不晚于当前时刻）。
 */
async function loadEffectiveScores(
  problemIds: string[],
  options: { userId?: string } = {},
  db: DbRoot = getDb(),
): Promise<Map<string, Map<string, number>>> {
  const result = new Map<string, Map<string, number>>();
  if (problemIds.length === 0) return result;
  const rows = await db.execute<{
    problem_id: string;
    user_id: string;
    score: number | null;
  }>(sql`
    WITH sel AS (
      SELECT s.problem_id, s.user_id, a.score
      FROM submissions s
      JOIN evaluation_attempts a ON a.id = s.effective_attempt_id
      LEFT JOIN contests c ON c.id = s.contest_id
      WHERE s.problem_id IN (${idList(problemIds)})
        ${
    options.userId === undefined
      ? sql``
      : sql`AND s.user_id = ${options.userId}`
  }
        AND (s.contest_id IS NULL OR (
          c.end_time ~ ${CONTEST_TIME_REGEX}
          AND pg_input_is_valid(c.end_time, 'timestamptz')
          AND c.end_time::timestamptz <= now()
        ))
      UNION ALL
      SELECT o.paper_id AS problem_id, o.user_id, a.score
      FROM objective_submissions o
      JOIN evaluation_attempts a ON a.id = o.effective_attempt_id
      LEFT JOIN contests oc ON oc.id = o.contest_id
      WHERE o.paper_id IN (${idList(problemIds)})
        ${
    options.userId === undefined
      ? sql``
      : sql`AND o.user_id = ${options.userId}`
  }
        AND (o.contest_id IS NULL OR (
          oc.end_time ~ ${CONTEST_TIME_REGEX}
          AND pg_input_is_valid(oc.end_time, 'timestamptz')
          AND oc.end_time::timestamptz <= now()
        ))
    )
    SELECT problem_id, user_id, max(score) AS score
    FROM sel
    GROUP BY problem_id, user_id
  `);
  for (
    const row of unwrapRows(rows as never) as {
      problem_id: string;
      user_id: string;
      score: number | null;
    }[]
  ) {
    const users = result.get(row.problem_id) ?? new Map<string, number>();
    users.set(row.user_id, row.score ?? 0);
    result.set(row.problem_id, users);
  }
  return result;
}

/** 题目达标参数（客观题满分 / 其它题型及格比例覆盖）。 */
async function loadPassOptions(
  problemIds: string[],
  db: DbRoot = getDb(),
): Promise<Map<string, PassOption>> {
  const map = new Map<string, PassOption>();
  if (problemIds.length === 0) return map;
  const rows = await db.select({
    id: problems.id,
    is_objective: problems.is_objective,
    pass_ratio_override: problemDifficulty.pass_ratio_override,
  }).from(problems)
    .leftJoin(
      problemDifficulty,
      eq(problemDifficulty.problem_id, problems.id),
    )
    .where(inArray(problems.id, problemIds));
  for (const row of rows) {
    map.set(row.id, {
      is_objective: row.is_objective,
      pass_ratio_override: row.pass_ratio_override ?? null,
      // 客观题套卷满分随小题数变化：逐卷读取作答版本的满分。
      full_score: row.is_objective ? await objectiveFullScore(row.id) : null,
    });
  }
  return map;
}

/** 单题答题统计：尝试人数（有有效成绩的去重用户数）与达标人数。 */
export async function loadProblemStats(
  problemIds: string[],
  db: DbRoot = getDb(),
): Promise<Map<string, { attempts: number; passed: number }>> {
  const result = new Map<string, { attempts: number; passed: number }>();
  if (problemIds.length === 0) return result;
  const [scores, options] = await Promise.all([
    loadEffectiveScores(problemIds, {}, db),
    loadPassOptions(problemIds, db),
  ]);
  for (const [problemId, users] of scores) {
    const option = options.get(problemId);
    if (!option) continue;
    let passed = 0;
    for (const score of users.values()) {
      if (isPassingScore(score, option)) passed++;
    }
    result.set(problemId, { attempts: users.size, passed });
  }
  return result;
}

/**
 * 某用户在给定题目中的达标题集合。
 *
 * 只读该用户的有效成绩（练习 + 已结束比赛），进行中比赛不计。
 */
export async function loadPassedProblems(
  userId: string,
  problemIds: string[],
  db: DbRoot = getDb(),
): Promise<Set<string>> {
  const passed = new Set<string>();
  if (problemIds.length === 0) return passed;
  const [scores, options] = await Promise.all([
    loadEffectiveScores(problemIds, { userId }, db),
    loadPassOptions(problemIds, db),
  ]);
  for (const [problemId, users] of scores) {
    const option = options.get(problemId);
    const score = users.get(userId);
    if (option && score !== undefined && isPassingScore(score, option)) {
      passed.add(problemId);
    }
  }
  return passed;
}

/** 题目难度视图（API 返回 `difficulty` 字段）。 */
export interface ProblemDifficultyView {
  score: number;
  tier: DifficultyTier;
  sample_size: number;
  pass_ratio_override: number | null;
}

/** 读取题目难度；无 `problem_difficulty` 行时回退出题人三档（score = prior）。 */
export async function readProblemDifficulty(
  problemId: string,
  db: DbRoot = getDb(),
): Promise<ProblemDifficultyView> {
  const [row] = await db.select().from(problemDifficulty).where(
    eq(problemDifficulty.problem_id, problemId),
  );
  if (row) {
    return {
      score: row.calibrated,
      tier: tierOf(row.calibrated),
      sample_size: row.sample_size,
      pass_ratio_override: row.pass_ratio_override,
    };
  }
  const [problem] = await db.select({ difficulty: problems.difficulty }).from(
    problems,
  ).where(eq(problems.id, problemId));
  const prior = tierToPrior(problem?.difficulty);
  return {
    score: prior,
    tier: tierOf(prior),
    sample_size: 0,
    pass_ratio_override: null,
  };
}

/** 批量读取难度分数（无校准行用先验）。 */
export async function loadDifficultyScores(
  problemIds: string[],
  db: DbRoot = getDb(),
): Promise<Map<string, { score: number; sample_size: number }>> {
  const result = new Map<string, { score: number; sample_size: number }>();
  if (problemIds.length === 0) return result;
  const [calibrated, priors] = await Promise.all([
    db.select({
      problem_id: problemDifficulty.problem_id,
      calibrated: problemDifficulty.calibrated,
      sample_size: problemDifficulty.sample_size,
    }).from(problemDifficulty).where(
      inArray(problemDifficulty.problem_id, problemIds),
    ),
    db.select({
      id: problems.id,
      difficulty: problems.difficulty,
    }).from(problems).where(inArray(problems.id, problemIds)),
  ]);
  for (const row of priors) {
    result.set(row.id, { score: tierToPrior(row.difficulty), sample_size: 0 });
  }
  for (const row of calibrated) {
    result.set(row.problem_id, {
      score: row.calibrated,
      sample_size: row.sample_size,
    });
  }
  return result;
}

/**
 * 重算单题难度并写入 `problem_difficulty`（保留出题人覆盖的及格线）。
 *
 * @returns 写入后的难度视图
 */
export async function recalibrateProblem(
  problemId: string,
  db: DbRoot = getDb(),
): Promise<ProblemDifficultyView> {
  const [problem] = await db.select({
    id: problems.id,
    difficulty: problems.difficulty,
  }).from(problems).where(eq(problems.id, problemId));
  if (!problem) {
    return {
      score: 0,
      tier: "easy",
      sample_size: 0,
      pass_ratio_override: null,
    };
  }
  const prior = tierToPrior(problem.difficulty);
  const stats = await loadProblemStats([problemId], db);
  const { attempts, passed } = stats.get(problemId) ?? {
    attempts: 0,
    passed: 0,
  };
  const { calibrated } = calibrateDifficulty(prior, attempts, passed);
  const now = new Date().toISOString();
  const [existing] = await db.select({
    pass_ratio_override: problemDifficulty.pass_ratio_override,
  }).from(problemDifficulty).where(
    eq(problemDifficulty.problem_id, problemId),
  );
  await db.insert(problemDifficulty).values({
    problem_id: problemId,
    prior,
    calibrated,
    sample_size: attempts,
    pass_ratio_override: existing?.pass_ratio_override ?? null,
    updated_at: now,
  }).onConflictDoUpdate({
    target: problemDifficulty.problem_id,
    set: { prior, calibrated, sample_size: attempts, updated_at: now },
  });
  return {
    score: calibrated,
    tier: tierOf(calibrated),
    sample_size: attempts,
    pass_ratio_override: existing?.pass_ratio_override ?? null,
  };
}

/**
 * 需要重算的题目：已发布（有最新版本）且（有知识点挂载或有有效提交）。
 *
 * keyset 分页（`afterId` 之后），避免大 offset。
 */
export async function listRecalibrateCandidates(
  options: { afterId?: string; limit?: number } = {},
  db: DbRoot = getDb(),
): Promise<string[]> {
  const limit = options.limit ?? RECALIBRATE_BATCH_SIZE;
  const rows = await db.select({ id: problems.id }).from(problems).where(
    and(
      isNotNull(problems.latest_version_id),
      options.afterId ? sql`${problems.id} > ${options.afterId}` : undefined,
      or(
        sql`EXISTS (SELECT 1 FROM problem_knowledge pk
          WHERE pk.problem_id = ${problems.id}
            AND pk.review_status <> 'rejected')`,
        sql`EXISTS (SELECT 1 FROM submissions s
          WHERE s.problem_id = ${problems.id}
            AND s.effective_attempt_id IS NOT NULL)`,
        sql`EXISTS (SELECT 1 FROM objective_submissions o
          WHERE o.paper_id = ${problems.id}
            AND o.effective_attempt_id IS NOT NULL)`,
      ),
    ),
  ).orderBy(problems.id).limit(limit);
  return rows.map((row) => row.id);
}

/** 全量重算（分批）；返回处理的题目数。 */
export async function recalibrateAll(db: DbRoot = getDb()): Promise<number> {
  let afterId: string | undefined;
  let total = 0;
  while (true) {
    const batch = await listRecalibrateCandidates(
      { afterId, limit: RECALIBRATE_BATCH_SIZE },
      db,
    );
    for (const id of batch) {
      await recalibrateProblem(id, db);
      total++;
    }
    if (batch.length < RECALIBRATE_BATCH_SIZE) break;
    afterId = batch[batch.length - 1];
  }
  return total;
}

/**
 * 多副本互斥执行一轮重算。
 *
 * 在**单个事务**内用 `pg_try_advisory_xact_lock` 取事务级锁（随提交/回滚自动
 * 释放，不会泄漏到连接池）：拿不到锁说明其他副本正在算，本轮返回 `null` 跳过。
 */
export async function runExclusiveRecalibration(
  db: DbRoot = getDb(),
): Promise<number | null> {
  const { namespace, key } = DIFFICULTY_RECALIBRATE_LOCK;
  return await db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${namespace}, ${key}) AS locked`,
    );
    const got = unwrapFirstRow<{ locked: boolean }>(locked as never)?.locked;
    if (!got) return null;
    return await recalibrateAll(db);
  });
}

let _difficultyTask: ManagedTask | null = null;

/**
 * 启动难度每日重算周期任务（单例；24h，启动后不立即执行）。
 *
 * 知识图谱总开关关闭时本轮直接跳过（不访问数据）。
 */
export function startDifficultyRecalibrateWorker(): ManagedTask {
  if (_difficultyTask !== null) return _difficultyTask;
  const task = startPeriodicTask({
    name: "knowledge-difficulty-recalibrate",
    intervalMs: DIFFICULTY_RECALIBRATE_INTERVAL_MS,
    runImmediately: false,
    run: async () => {
      if (getSetting("knowledge_enabled")?.value !== true) return;
      const count = await runExclusiveRecalibration();
      if (count !== null) {
        logger.info("知识图谱难度重算完成", { problems: count });
      }
    },
    onError: (error) => {
      logger.warn("知识图谱难度重算失败，下一轮重试", {
        error_type: error instanceof Error ? error.name : "Error",
      });
    },
  });
  _difficultyTask = task;
  void task.done.then(() => {
    if (_difficultyTask === task) _difficultyTask = null;
  });
  return task;
}

/** 测试用：停止并释放单例。 */
export function _stopDifficultyRecalibrateWorkerForTest(): void {
  _difficultyTask?.stop();
  _difficultyTask = null;
}

// ── 阶梯与「下一题」──────────────────────────────────

/** 阶梯条目。 */
export interface LadderItem {
  problem_id: string;
  number: number | null;
  title: string;
  /** 所属域 slug（跨域题目按 `/d/<域>/…` 链接呈现）。 */
  domain: string;
  difficulty: number;
  tier: DifficultyTier;
  sample_size: number;
  /** 当前用户是否达标；未登录为 null。 */
  passed: boolean | null;
}

/** 解析可用领域（按 slug）；不存在或当前用户不可访问 → null。 */
export async function resolveAccessibleDomain(
  slug: string,
  actor: UserActor | null,
): Promise<{ id: string; slug: string } | null> {
  const [row] = await getDb().select({ id: domains.id, slug: domains.slug })
    .from(domains).where(eq(domains.slug, slug));
  if (!row) return null;
  try {
    await loadWorkspace(slug, actor ?? { kind: "guest" });
  } catch {
    return null;
  }
  return row;
}

type LadderRow = {
  problem_id: string;
  number: number | null;
  title: string;
  slug: string;
  difficulty: string;
  calibrated: number | null;
  sample_size: number | null;
} & Record<string, unknown>;

/**
 * 某域中「指定节点为主知识点」的已发布、可访问题目（按难度升序）。
 *
 * 过滤：已发布（有内容版本）、域绑定未禁用、源域未停用、非进行中比赛 /
 * 保密保护期（design.md 第 11 节）。`is_admin` 为 true 时保护期题目仍可见
 * （与题目读取口径一致：管理员可预览）。
 */
export async function loadLadderItems(
  nodeId: string,
  domainId: string,
  viewer: UserActor | null,
  options: { is_admin?: boolean; include_unpublished?: boolean } = {},
): Promise<LadderItem[]> {
  return await loadNodeProblems(nodeId, domainId, viewer, options);
}

/**
 * 某域中「指定节点为主知识点」的题目（阶梯与计数共用的取数口径）。
 *
 * 过滤：域绑定未禁用、源域未停用、已发布（管理员可含未发布）、非进行中比赛 /
 * 保密保护期。结果按难度升序，并标注当前用户是否达标。
 */
async function loadNodeProblems(
  nodeId: string,
  domainId: string,
  viewer: UserActor | null,
  options: { is_admin?: boolean; include_unpublished?: boolean },
): Promise<LadderItem[]> {
  const rows = await getDb().execute<LadderRow>(sql`
    SELECT p.id AS problem_id, p.number, p.title, d.slug, p.difficulty,
           pd.calibrated, pd.sample_size
    FROM problem_knowledge pk
    JOIN knowledge_nodes kn ON kn.id = pk.node_id AND kn.status = 'active'
    JOIN problems p ON p.id = pk.problem_id
    JOIN domains d ON d.id = p.domain_id
    JOIN domain_problem_bindings b
      ON b.domain_id = p.domain_id AND b.problem_id = p.id
    LEFT JOIN problem_difficulty pd ON pd.problem_id = p.id
    WHERE pk.node_id = ${nodeId}
      AND pk.role = 'primary'
      AND pk.review_status IN ('auto', 'confirmed')
      AND p.domain_id = ${domainId}
      AND b.disabled_at IS NULL
      AND d.status <> 'suspended'
      AND (${options.include_unpublished === true} OR (
        p.latest_version_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM problem_versions v WHERE v.problem_id = p.id
          AND v.id = CASE WHEN p.effective_version_mode = 'exact'
            THEN p.required_version_id ELSE p.latest_version_id END)
      ))
  `);
  const prepared = (unwrapRows(rows as never) as LadderRow[]).map((row) => {
    const score = row.calibrated ?? tierToPrior(row.difficulty);
    return {
      row,
      score,
      tier: tierOf(score),
      sample_size: row.sample_size ?? 0,
    };
  }).sort((a, b) =>
    a.score - b.score ||
    (a.row.number ?? Number.MAX_SAFE_INTEGER) -
      (b.row.number ?? Number.MAX_SAFE_INTEGER) ||
    a.row.problem_id.localeCompare(b.row.problem_id)
  );
  const protection = await loadDomainProblemProtection(
    domainId,
    prepared.map((item) => item.row.problem_id),
  );
  const visible = prepared.filter((item) =>
    options.is_admin === true ||
    (protection.get(item.row.problem_id) ?? []).length === 0
  );
  const passed = viewer
    ? await loadPassedProblems(
      viewer.userId,
      visible.map((item) => item.row.problem_id),
    )
    : null;
  return visible.map((item) => ({
    problem_id: item.row.problem_id,
    number: item.row.number,
    title: item.row.title,
    domain: item.row.slug,
    difficulty: item.score,
    tier: item.tier,
    sample_size: item.sample_size,
    passed: passed ? passed.has(item.row.problem_id) : null,
  }));
}

/**
 * 各知识点在该域的可访问题目数（主动知识点口径；供「只显示有题的知识点」）。
 *
 * 计数与阶梯同一口径（已发布、绑定未禁用、非保护期）。
 */
export async function loadNodeProblemCounts(
  nodeIds: string[],
  domainId: string,
  viewer: UserActor | null,
  options: { is_admin?: boolean } = {},
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const unique = [...new Set(nodeIds)];
  if (unique.length === 0) return counts;
  for (const nodeId of unique) {
    const items = await loadNodeProblems(nodeId, domainId, viewer, options);
    counts.set(nodeId, items.length);
  }
  return counts;
}

/**
 * 「下一题」：难度 ≥ `minDifficulty` 的第一道未达标题。
 *
 * 未登录（`passed` 全为 null）时取第一条；全部达标返回 null。
 */
export function pickNextLadderItem(
  items: readonly LadderItem[],
  options: { minDifficulty?: number } = {},
): LadderItem | null {
  const min = options.minDifficulty;
  return items.find((item) =>
    item.passed !== true && (min === undefined || item.difficulty >= min)
  ) ?? null;
}

/** 阶梯视图（`GET /knowledge/nodes/:id/ladder` 的 `data`）。 */
export interface NodeLadderView {
  node_id: string;
  domain: string;
  items: LadderItem[];
  next: LadderItem | null;
}

/**
 * 读取节点阶梯；节点不存在/已废弃或域不可访问返回 null。
 *
 * `next`：难度 ≥ 用户已达标最高难度的第一道未达标题；未登录为第一题；
 * 全部达标为 null。
 */
export async function readNodeLadder(
  nodeId: string,
  domainSlug: string,
  viewer: UserActor | null,
  options: { is_admin?: boolean; include_unpublished?: boolean } = {},
): Promise<NodeLadderView | null> {
  const [node] = await getDb().select({ id: knowledgeNodes.id }).from(
    knowledgeNodes,
  ).where(and(
    eq(knowledgeNodes.id, nodeId),
    eq(knowledgeNodes.status, "active"),
  ));
  if (!node) return null;
  const domain = await resolveAccessibleDomain(domainSlug, viewer);
  if (!domain) return null;
  const items = await loadLadderItems(nodeId, domain.id, viewer, options);
  const passedScores = items.filter((item) => item.passed === true).map(
    (item) => item.difficulty,
  );
  const next = viewer === null ? items[0] ?? null : pickNextLadderItem(items, {
    minDifficulty: passedScores.length > 0
      ? Math.max(...passedScores)
      : undefined,
  });
  return { node_id: nodeId, domain: domain.slug, items, next };
}

/**
 * 题目页「下一题」：该题主知识点阶梯中难度高于本题、用户未达标的第一题。
 *
 * 题目未归类（无主知识点）或阶梯中没有更高难度时返回 null。
 */
export async function readNextForProblem(
  problemId: string,
  viewer: UserActor | null,
  options: { is_admin?: boolean } = {},
): Promise<LadderItem | null> {
  const [row] = await getDb().select({
    node_id: problemKnowledge.node_id,
    domain_id: problems.domain_id,
  }).from(problemKnowledge)
    .innerJoin(problems, eq(problems.id, problemKnowledge.problem_id))
    .where(and(
      eq(problemKnowledge.problem_id, problemId),
      eq(problemKnowledge.role, "primary"),
      ne(problemKnowledge.review_status, "rejected"),
    )).limit(1);
  if (!row) return null;
  const currentScore = (await loadDifficultyScores([problemId])).get(
    problemId,
  )?.score ?? tierToPrior(null);
  const items = await loadLadderItems(
    row.node_id,
    row.domain_id,
    viewer,
    options,
  );
  const above = items.filter((item) =>
    item.problem_id !== problemId && item.difficulty > currentScore
  );
  return pickNextLadderItem(above);
}
