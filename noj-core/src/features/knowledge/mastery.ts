/**
 * 用户 × 知识点掌握度（P3，见 design.md 第 8 节）。
 *
 * - 只统计用户在该节点（作为**主知识点**）题目上的成绩；只计练习有效成绩与
 *   已结束比赛成绩（进行中比赛、比赛保密保护期题目不计）。
 * - `learning`：任一题达标；`mastered`：达标题数 ≥ K
 *   （{@link masteryMinSolved}）且至少一道达标题难度位于该节点题目难度上
 *   三分之一；节点题量 < K 时为「全部达标」。
 * - 「达标」复用 P2 的判定（一次读取有效成绩即得最高分，故
 *   `isPassingScore(max)` 等价于「存在一次达标提交」）。
 * - 增量：有效成绩变更处在事务内投递 `knowledge.mastery`
 *   （`evaluations/services/versioning/knowledge-mastery-task.ts`），处理时重算该用户全部相关节点。
 * - 比赛保护结束：题目保护期间其成绩不计；保护结束后由周期任务
 *   （{@link startMasteryProtectionWorker}，1h）对近期结束保护的题目相关用户
 *   重算（[`MASTERY_PROTECTION_LOOKBACK_MS`] 窗口内每轮幂等重算）。
 */
import { and, eq, sql } from "drizzle-orm";
import { userActorFromAuthenticatedId } from "../../shared/access/actor.ts";
import { loadDomainProblemProtection } from "../../modules/access/index.ts";
import { getSetting } from "../../shared/config/system-settings.ts";
import {
  type ClaimedTask,
  type TaskHandler,
} from "../../shared/tasks/contracts.ts";
import {
  KNOWLEDGE_MASTERY_TARGET_KIND,
  KNOWLEDGE_MASTERY_TASK_TYPE,
} from "../../modules/evaluations/index.ts";
import { logger } from "../../shared/base/logging.ts";
import { unwrapRows } from "../../shared/base/sql-rows.ts";
import { getDb } from "../../shared/db/connection.ts";
import type { DbRoot } from "../../shared/db/executor.ts";
import {
  userKnowledgeMastery,
  userKnowledgePlacements,
} from "../../shared/db/schema.ts";
import type { ManagedTask } from "../../shared/runtime/managed-task.ts";
import { startPeriodicTask } from "../../shared/runtime/managed-task.ts";
import {
  isPassingScore,
  type LadderItem,
  readNodeLadder,
  tierOf,
  tierToPrior,
} from "./difficulty.ts";
import { type KnowledgeGraphNode, readKnowledgeGraph } from "./graph.ts";
import { objectiveFullScore } from "./objective-full-score.ts";

/** 掌握状态三态。 */
export type MasteryState = "none" | "learning" | "mastered";

/** 默认「已掌握」所需达标题数（与注册表默认值一致）。 */
export const DEFAULT_MASTERY_MIN_SOLVED = 3;

/** 保护结束后回看窗口：每轮重算该窗口内结束保护的题目相关用户。 */
export const MASTERY_PROTECTION_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** 保护结束重算周期任务间隔：1 小时（启动后不立即执行）。 */
export const MASTERY_PROTECTION_INTERVAL_MS = 60 * 60 * 1000;

/** 保护结束重算的 advisory lock 键（与难度重算同一 namespace、不同 key）。 */
export const MASTERY_PROTECTION_LOCK = {
  namespace: 0x4e4f4a4b,
  key: 2,
} as const;

/** 读取「已掌握」所需达标题数 K（越界回退默认值，范围 1–20）。 */
export function masteryMinSolved(): number {
  const raw = getSetting("knowledge_mastery_min_solved")?.value;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_MASTERY_MIN_SOLVED;
  }
  return Math.min(20, Math.max(1, Math.round(raw)));
}

/** 单节点掌握度计算的输入（纯函数）。 */
export interface NodeMasteryInput {
  /** 节点作为主知识点的题目数（同一可统计口径；含未达标题）。 */
  total: number;
  /** 用户达标题的难度分（校准难度；无校准行用先验）。 */
  passed_difficulties: readonly number[];
  /** 节点全部题目（含未达标）的难度分。 */
  difficulties: readonly number[];
  solved_count: number;
  attempted_count: number;
  failed_attempts: number;
}

/** 单节点掌握度计算结果。 */
export interface NodeMasteryResult {
  state: MasteryState;
  solved_count: number;
  attempted_count: number;
  failed_attempts: number;
  max_passed_difficulty: number | null;
}

/** 难度三分位上界（不含）：上三分之一为 `>=` 此值。 */
export function upperThirdThreshold(difficulties: readonly number[]): number {
  if (difficulties.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...difficulties].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length * 2) / 3)]!;
}

/**
 * 掌握度判定（纯函数）。
 *
 * - 无达标题 → `none`；有达标题且未满足 `mastered` → `learning`；
 * - `mastered`：题量 ≥ K 时达标题数 ≥ K 且至少一道达标难度 ≥ 上三分之一阈值；
 *   题量 < K 时为全部达标（且至少一道，题量为 0 时不可能掌握）。
 */
export function computeNodeMastery(
  input: NodeMasteryInput,
  minSolved: number = DEFAULT_MASTERY_MIN_SOLVED,
): NodeMasteryResult {
  const solved = Math.max(0, input.passed_difficulties.length);
  const total = Math.max(0, input.total);
  let mastered = false;
  if (solved > 0 && total > 0) {
    const threshold = upperThirdThreshold(input.difficulties);
    const hasHard = input.passed_difficulties.some((d) => d >= threshold);
    mastered = total < minSolved
      ? solved >= total
      : solved >= minSolved && hasHard;
  }
  return {
    state: mastered ? "mastered" : solved > 0 ? "learning" : "none",
    solved_count: input.solved_count,
    attempted_count: input.attempted_count,
    failed_attempts: input.failed_attempts,
    max_passed_difficulty: solved > 0
      ? Math.max(...input.passed_difficulties)
      : null,
  };
}

// ── 取数（与 P2 阶梯同口径）──────────────────────────────

type NodeProblemRow = {
  node_id: string;
  problem_id: string;
  domain_id: string;
  slug: string;
  is_objective: boolean;
  pass_ratio_override: number | null;
  difficulty: string;
  calibrated: number | null;
} & Record<string, unknown>;

/** 某用户在某题上的有效成绩（最高分）与未达标提交数。 */
interface UserProblemScore {
  /** 有效成绩最高分（×100 记分；无有效成绩为空）。 */
  best: number | null;
  /** 未达标提交次数（全部正式提交中未达标的尝试数）。 */
  failed_attempts: number;
}

type UserScoreRow = {
  problem_id: string;
  kind: string;
  best: number | null;
  failed_attempts: number;
} & Record<string, unknown>;

/** 赛期时间格式（与 access 合同同一口径）。 */
const CONTEST_TIME_REGEX =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

/**
 * 节点题目行（全部可统计题目，含用户未提交的题；难度断层判定用）。
 *
 * 口径与 P2 阶梯一致：主动知识点、`auto`/`confirmed`、active 节点、源域未
 * 停用、域绑定未禁用、已发布。
 */
export async function loadNodeProblems(
  db: DbRoot = getDb(),
): Promise<NodeProblemRow[]> {
  const rows = await db.execute<NodeProblemRow>(sql`
    SELECT pk.node_id, p.id AS problem_id, p.domain_id, d.slug,
           p.is_objective, pd.pass_ratio_override, p.difficulty, pd.calibrated
    FROM problem_knowledge pk
    JOIN knowledge_nodes kn ON kn.id = pk.node_id AND kn.status = 'active'
    JOIN problems p ON p.id = pk.problem_id
    JOIN domains d ON d.id = p.domain_id
    JOIN domain_problem_bindings b
      ON b.domain_id = p.domain_id AND b.problem_id = p.id
    LEFT JOIN problem_difficulty pd ON pd.problem_id = p.id
    WHERE pk.role = 'primary'
      AND pk.review_status IN ('auto', 'confirmed')
      AND b.disabled_at IS NULL
      AND d.status <> 'suspended'
      AND p.latest_version_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM problem_versions v WHERE v.problem_id = p.id
        AND v.id = CASE WHEN p.effective_version_mode = 'exact'
          THEN p.required_version_id ELSE p.latest_version_id END)
  `);
  return unwrapRows(rows as never) as NodeProblemRow[];
}

/**
 * 待确认挂载（`review_status = 'pending'）的节点题目行（仅覆盖度题量用）。
 *
 * 口径与 {@link loadNodeProblems} 相同，仅放宽 `review_status`。
 */
async function loadNodePendingCounts(
  db: DbRoot = getDb(),
): Promise<{ node_id: string; problem_id: string; domain_id: string }[]> {
  const rows = await db.execute(sql`
    SELECT pk.node_id, p.id AS problem_id, p.domain_id
    FROM problem_knowledge pk
    JOIN knowledge_nodes kn ON kn.id = pk.node_id AND kn.status = 'active'
    JOIN problems p ON p.id = pk.problem_id
    JOIN domains d ON d.id = p.domain_id
    JOIN domain_problem_bindings b
      ON b.domain_id = p.domain_id AND b.problem_id = p.id
    WHERE pk.role = 'primary'
      AND pk.review_status = 'pending'
      AND b.disabled_at IS NULL
      AND d.status <> 'suspended'
      AND p.latest_version_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM problem_versions v WHERE v.problem_id = p.id
        AND v.id = CASE WHEN p.effective_version_mode = 'exact'
          THEN p.required_version_id ELSE p.latest_version_id END)
  `);
  return unwrapRows(rows as never) as {
    node_id: string;
    problem_id: string;
    domain_id: string;
  }[];
}

/** 节点题目难度分（无校准行用先验）。 */
export function scoreOfNodeProblem(row: NodeProblemRow): number {
  return row.calibrated ?? tierToPrior(row.difficulty);
}

/**
 * 用户在特定题目集合上的有效成绩（练习 + 已结束比赛）与未达标次数。
 *
 * `best` 为分题型（普通提交 / 客观题套卷）的最高有效分；未达标次数按全部正式
 * 提交（含进行中比赛，仅用于根因诊断展示「多次未达标」）的未通过尝试数统计。
 */
export async function loadUserProblemScores(
  userId: string,
  problemIds: string[],
  db: DbRoot = getDb(),
): Promise<Map<string, UserProblemScore>> {
  const result = new Map<string, UserProblemScore>();
  if (problemIds.length === 0) return result;
  const ids = sql.join(problemIds.map((id) => sql`${id}`), sql`, `);
  const rows = await db.execute<UserScoreRow>(sql`
    WITH eff AS (
      SELECT s.problem_id, 'submission' AS kind, a.score, a.accepted, s.contest_id
      FROM submissions s
      JOIN evaluation_attempts a ON a.id = s.effective_attempt_id
      WHERE s.user_id = ${userId} AND s.problem_id IN (${ids})
      UNION ALL
      SELECT o.paper_id AS problem_id, 'objective' AS kind,
             a.score, a.accepted, o.contest_id
      FROM objective_submissions o
      JOIN evaluation_attempts a ON a.id = o.effective_attempt_id
      WHERE o.user_id = ${userId} AND o.paper_id IN (${ids})
    )
    SELECT e.problem_id, e.kind,
           count(*) FILTER (WHERE NOT e.accepted)::int AS failed_attempts,
           max(e.score) FILTER (WHERE e.contest_id IS NULL OR (
             c.end_time ~ ${CONTEST_TIME_REGEX}
             AND pg_input_is_valid(c.end_time, 'timestamptz')
             AND c.end_time::timestamptz <= now()
           )) AS best
    FROM eff e
    LEFT JOIN contests c ON c.id = e.contest_id
    GROUP BY e.problem_id, e.kind
  `);
  for (const row of unwrapRows(rows as never) as UserScoreRow[]) {
    // 同一题目可能同时有普通提交与客观题套卷成绩：合并为该题的最高分与失败数。
    const previous = result.get(row.problem_id);
    result.set(row.problem_id, {
      best: previous?.best == null
        ? row.best
        : row.best == null
        ? previous.best
        : Math.max(previous.best, row.best),
      failed_attempts: Math.max(
        previous?.failed_attempts ?? 0,
        row.failed_attempts,
      ),
    });
  }
  return result;
}

/** 比赛保密保护中的题目 ID 集合（进行中 + 未结束保护；口径见 access）。 */
async function loadProtectedProblems(
  pairs: readonly { domain_id: string; problem_id: string }[],
): Promise<Set<string>> {
  const byDomain = new Map<string, string[]>();
  for (const pair of pairs) {
    const list = byDomain.get(pair.domain_id) ?? [];
    list.push(pair.problem_id);
    byDomain.set(pair.domain_id, list);
  }
  const protectedIds = new Set<string>();
  await Promise.all([...byDomain].map(async ([domainId, ids]) => {
    const map = await loadDomainProblemProtection(domainId, ids);
    for (const [problemId, refs] of map) {
      if (refs.length > 0) protectedIds.add(problemId);
    }
  }));
  return protectedIds;
}

/** 客观题套卷满分缓存（同一轮内逐卷只读一次）。 */
class FullScoreCache {
  private readonly cache = new Map<string, number | null>();
  async get(problemId: string): Promise<number | null> {
    if (!this.cache.has(problemId)) {
      this.cache.set(problemId, await objectiveFullScore(problemId));
    }
    return this.cache.get(problemId) ?? null;
  }
}

/** 单用户在全部相关节点上的掌握度计算结果。 */
export interface UserMasteryResult {
  userId: string;
  /** 本次写入的节点数。 */
  nodes: number;
  mastered: number;
  learning: number;
}

/** 题目的及格参数（含客观题套卷满分）。 */
async function passOptionOf(
  row: NodeProblemRow,
  fullScores: FullScoreCache,
): Promise<
  {
    is_objective: boolean;
    pass_ratio_override: number | null;
    full_score: number | null;
  }
> {
  return {
    is_objective: row.is_objective,
    pass_ratio_override: row.pass_ratio_override ?? null,
    full_score: row.is_objective ? await fullScores.get(row.problem_id) : null,
  };
}

/**
 * 重算某用户的掌握度快照并写入 `user_knowledge_mastery`（增量任务与测试入口）。
 *
 * 只保留有达标 / 有有效成绩 / 有失败尝试的节点；已有记录但本次已无任何成绩的
 * 节点删除（例如保护期内的成绩不再计入后回到无记录）。总开关关闭时不写库。
 */
export async function recomputeUserMastery(
  userId: string,
  db: DbRoot = getDb(),
): Promise<UserMasteryResult> {
  const empty = { userId, nodes: 0, mastered: 0, learning: 0 };
  if (getSetting("knowledge_enabled")?.value !== true) return empty;
  const rows = await loadNodeProblems(db);
  if (rows.length === 0) {
    await db.delete(userKnowledgeMastery).where(
      eq(userKnowledgeMastery.user_id, userId),
    );
    return empty;
  }
  const scores = await loadUserProblemScores(
    userId,
    rows.map((row) => row.problem_id),
    db,
  );
  const protectedIds = await loadProtectedProblems(rows);
  const fullScores = new FullScoreCache();
  const minSolved = masteryMinSolved();

  /** 节点 → 全部题目（难度）与用户成绩。 */
  const perNode = new Map<string, {
    difficulties: number[];
    passed: number[];
    solved: number;
    attempted: number;
    failed: number;
  }>();
  for (const row of rows) {
    const agg = perNode.get(row.node_id) ??
      { difficulties: [], passed: [], solved: 0, attempted: 0, failed: 0 };
    perNode.set(row.node_id, agg);
    if (protectedIds.has(row.problem_id)) continue;
    const score = scoreOfNodeProblem(row);
    agg.difficulties.push(score);
    const mine = scores.get(row.problem_id);
    if (!mine) continue;
    agg.failed += mine.failed_attempts;
    if (mine.best !== null) {
      agg.attempted++;
      if (isPassingScore(mine.best, await passOptionOf(row, fullScores))) {
        agg.passed.push(score);
        agg.solved++;
      }
    }
  }

  const now = new Date().toISOString();
  const existing = await db.select({ node_id: userKnowledgeMastery.node_id })
    .from(userKnowledgeMastery).where(
      eq(userKnowledgeMastery.user_id, userId),
    );
  const existingIds = new Set(existing.map((row) => row.node_id));
  const keep = new Set<string>();
  let mastered = 0;
  let learning = 0;
  for (const [nodeId, agg] of perNode) {
    const touched = agg.attempted > 0 || agg.failed > 0;
    if (!touched) continue;
    keep.add(nodeId);
    const result = computeNodeMastery({
      total: agg.difficulties.length,
      passed_difficulties: agg.passed,
      difficulties: agg.difficulties,
      solved_count: agg.solved,
      attempted_count: agg.attempted,
      failed_attempts: agg.failed,
    }, minSolved);
    if (result.state === "mastered") mastered++;
    else if (result.state === "learning") learning++;
    await db.insert(userKnowledgeMastery).values({
      user_id: userId,
      node_id: nodeId,
      ...result,
      updated_at: now,
    }).onConflictDoUpdate({
      target: [userKnowledgeMastery.user_id, userKnowledgeMastery.node_id],
      set: { ...result, updated_at: now },
    });
  }
  const stale = [...existingIds].filter((nodeId) => !keep.has(nodeId));
  if (stale.length > 0) {
    await db.delete(userKnowledgeMastery).where(and(
      eq(userKnowledgeMastery.user_id, userId),
      sql`${userKnowledgeMastery.node_id} IN (${
        sql.join(
          stale.map((id) => sql`${id}`),
          sql`, `,
        )
      })`,
    ));
  }
  return { userId, nodes: keep.size, mastered, learning };
}

/** `knowledge.mastery` 任务 handler：target = 用户，整体重算其掌握度。 */
export const knowledgeMasteryHandler: TaskHandler = async (
  task: ClaimedTask,
): Promise<Record<string, unknown>> => {
  // 总开关关闭：直接成功结束、不产生副作用。
  if (getSetting("knowledge_enabled")?.value !== true) {
    return { status: "disabled" };
  }
  const userId = task.targetId;
  const result = await recomputeUserMastery(userId);
  return {
    status: "recomputed",
    nodes: result.nodes,
    mastered: result.mastered,
    learning: result.learning,
  };
};

/** 掌握度任务目标类别（与 `evaluations/services/versioning/knowledge-mastery-task.ts` 一致）。 */
export const MASTERY_TARGET_KIND = KNOWLEDGE_MASTERY_TARGET_KIND;

/** 掌握度任务类型（与 `evaluations/services/versioning/knowledge-mastery-task.ts` 一致）。 */
export const MASTERY_TASK_TYPE = KNOWLEDGE_MASTERY_TASK_TYPE;

/**
 * 近期结束保护、且用户有练习有效成绩或已结束比赛成绩的题目用户。
 *
 * 保护期间这些成绩不计入掌握度；保护结束后需重算（窗口内幂等）。
 */
async function listRecentProtectionEndUsers(
  now: Date,
  db: DbRoot = getDb(),
): Promise<string[]> {
  const since = new Date(now.getTime() - MASTERY_PROTECTION_LOOKBACK_MS)
    .toISOString();
  const rows = await db.execute<{ user_id: string }>(sql`
    WITH ended AS (
      SELECT p.id AS problem_id, p.domain_id
      FROM problems p
      JOIN contest_problems cp ON cp.problem_id = p.id
      JOIN contests c ON c.id = cp.contest_id
      WHERE EXISTS (
        SELECT 1 FROM problem_knowledge pk
        WHERE pk.problem_id = p.id AND pk.role = 'primary'
          AND pk.review_status IN ('auto', 'confirmed')
      )
        AND c.end_time ~ ${CONTEST_TIME_REGEX}
        AND pg_input_is_valid(c.end_time, 'timestamptz')
        AND c.end_time::timestamptz > ${since}::timestamptz
        AND c.end_time::timestamptz <= now()
    )
    SELECT DISTINCT u.user_id FROM ended e
    JOIN (
      SELECT problem_id, user_id FROM submissions
      WHERE effective_attempt_id IS NOT NULL
      UNION ALL
      SELECT paper_id AS problem_id, user_id FROM objective_submissions
      WHERE effective_attempt_id IS NOT NULL
    ) u ON u.problem_id = e.problem_id
  `);
  return (unwrapRows(rows as never) as { user_id: string }[]).map((row) =>
    row.user_id
  );
}

/**
 * 重算近期结束保护题目相关的用户（多副本互斥；总开关关闭时不访问数据）。
 *
 * @returns 处理的用户数；拿不到锁时返回 null。
 */
export async function recomputeRecentlyUnprotectedMastery(
  db: DbRoot = getDb(),
  now: Date = new Date(),
): Promise<number | null> {
  if (getSetting("knowledge_enabled")?.value !== true) return 0;
  const { namespace, key } = MASTERY_PROTECTION_LOCK;
  return await db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${namespace}, ${key}) AS locked`,
    );
    const got = (locked as unknown as { locked?: boolean }[])[0]?.locked;
    if (!got) return null;
    const userIds = await listRecentProtectionEndUsers(now, db);
    for (const userId of userIds) {
      await recomputeUserMastery(userId, db);
    }
    return userIds.length;
  });
}

let _masteryTask: ManagedTask | null = null;

/** 启动保护结束重算周期任务（单例；1h，启动后不立即执行）。 */
export function startMasteryProtectionWorker(): ManagedTask {
  if (_masteryTask !== null) return _masteryTask;
  const task = startPeriodicTask({
    name: "knowledge-mastery-protection",
    intervalMs: MASTERY_PROTECTION_INTERVAL_MS,
    runImmediately: false,
    run: async () => {
      const count = await recomputeRecentlyUnprotectedMastery();
      if (count !== null && count > 0) {
        logger.info("知识图谱掌握度保护结束重算完成", { users: count });
      }
    },
    onError: (error) => {
      logger.warn("知识图谱掌握度保护结束重算失败，下一轮重试", {
        error_type: error instanceof Error ? error.name : "Error",
      });
    },
  });
  _masteryTask = task;
  void task.done.then(() => {
    if (_masteryTask === task) _masteryTask = null;
  });
  return task;
}

/** 测试用：停止并释放单例。 */
export function _stopMasteryProtectionWorkerForTest(): void {
  _masteryTask?.stop();
  _masteryTask = null;
}

/** 读取某用户全部掌握度记录（API 与推荐共用）。 */
export async function loadUserMastery(
  userId: string,
  db: DbRoot = getDb(),
): Promise<
  Map<string, {
    state: MasteryState;
    solved_count: number;
    attempted_count: number;
    failed_attempts: number;
    max_passed_difficulty: number | null;
    updated_at: string;
  }>
> {
  const rows = await db.select().from(userKnowledgeMastery).where(
    eq(userKnowledgeMastery.user_id, userId),
  );
  const map = new Map<string, {
    state: MasteryState;
    solved_count: number;
    attempted_count: number;
    failed_attempts: number;
    max_passed_difficulty: number | null;
    updated_at: string;
  }>();
  for (const row of rows) {
    map.set(row.node_id, {
      state: row.state as MasteryState,
      solved_count: row.solved_count,
      attempted_count: row.attempted_count,
      failed_attempts: row.failed_attempts,
      max_passed_difficulty: row.max_passed_difficulty,
      updated_at: row.updated_at,
    });
  }
  return map;
}

/** 读取用户通过摸底自评或诊断解锁的节点 ID 集合。 */
export async function loadUserPlacementIds(
  userId: string,
  db: DbRoot = getDb(),
): Promise<Set<string>> {
  const rows = await db.select({ node_id: userKnowledgePlacements.node_id })
    .from(userKnowledgePlacements)
    .where(eq(userKnowledgePlacements.user_id, userId));
  return new Set(rows.map((row) => row.node_id));
}

// ── API 读取（掌握度、根因诊断、推荐、覆盖度）──────────────

/** 掌握度条目（`GET /knowledge/me/mastery`）。 */
export interface MasteryItem {
  node_id: string;
  name: string;
  area: string;
  state: MasteryState;
  solved_count: number;
  attempted_count: number;
  failed_attempts: number;
  max_passed_difficulty: number | null;
  /** 该域中该节点为主动知识点的可访问题目数。 */
  problem_count: number;
}

/** 掌握度视图。 */
export interface MyMasteryView {
  domain: { id: string; slug: string };
  mastered: number;
  learning: number;
  total: number;
  /** 通过摸底诊断/自评解锁的知识点 ID。 */
  placed_nodes: string[];
  items: MasteryItem[];
}

/**
 * 用户在某域的掌握度（只返回有题或有记录的节点）。
 *
 * `domainId` 为空时不按域过滤（`domain` 为 null）。
 */
export async function readMyMastery(
  userId: string,
  domain: { id: string; slug: string } | null,
  db: DbRoot = getDb(),
): Promise<MyMasteryView> {
  const graph = await readKnowledgeGraph();
  const [mastery, placedIds, rows] = await Promise.all([
    loadUserMastery(userId, db),
    loadUserPlacementIds(userId, db),
    loadNodeProblems(db),
  ]);
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (domain && row.domain_id !== domain.id) continue;
    counts.set(row.node_id, (counts.get(row.node_id) ?? 0) + 1);
  }
  const items: MasteryItem[] = [];
  for (const node of graph.nodes) {
    const record = mastery.get(node.id);
    const count = counts.get(node.id) ?? 0;
    if (!record && count === 0) continue;
    items.push({
      node_id: node.id,
      name: node.name,
      area: node.area,
      state: record?.state ?? "none",
      solved_count: record?.solved_count ?? 0,
      attempted_count: record?.attempted_count ?? 0,
      failed_attempts: record?.failed_attempts ?? 0,
      max_passed_difficulty: record?.max_passed_difficulty ?? null,
      problem_count: count,
    });
  }
  let mastered = 0;
  let learning = 0;
  for (const item of items) {
    if (item.state === "mastered") mastered++;
    else if (item.state === "learning") learning++;
  }
  return {
    domain: domain ?? { id: "", slug: "" },
    mastered,
    learning,
    total: items.length,
    placed_nodes: [...placedIds].sort(),
    items,
  };
}

/** 根因诊断中的一个未掌握前置（按层级升序）。 */
export interface DiagnosisItem {
  node_id: string;
  name: string;
  /** 与目标节点的最短层级：直接前置为 1。 */
  depth: number;
  state: MasteryState;
  failed_attempts: number;
}

/** 根因诊断视图。 */
export interface NodeDiagnosisView {
  node_id: string;
  state: MasteryState;
  /** 直接前置中未掌握者（建议先学）。 */
  missing_prerequisites: DiagnosisItem[];
  /** 未掌握前置链（含多级，按层级升序，最多 5 个）。 */
  chain: DiagnosisItem[];
}

/** 诊断链最大节点数。 */
export const DIAGNOSIS_MAX_ITEMS = 5;

/**
 * 根因诊断：给定节点的未掌握前置链（BFS 按层级，最多 5 个）。
 *
 * 节点不存在或已废弃返回 null。
 */
export async function diagnoseNode(
  userId: string,
  nodeId: string,
  db: DbRoot = getDb(),
): Promise<NodeDiagnosisView | null> {
  const graph = await readKnowledgeGraph();
  const target = graph.nodes.find((node) => node.id === nodeId);
  if (!target) return null;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const [mastery, placedIds] = await Promise.all([
    loadUserMastery(userId, db),
    loadUserPlacementIds(userId, db),
  ]);
  const stateOf = (id: string): MasteryState =>
    mastery.get(id)?.state ?? "none";
  const isUnlocked = (id: string): boolean =>
    stateOf(id) === "mastered" || placedIds.has(id);
  const missingDirect = target.requires.filter((id) => !isUnlocked(id));
  const chain: DiagnosisItem[] = [];
  const seen = new Set<string>([nodeId]);
  let frontier = target.requires.filter((id) => byId.has(id));
  let depth = 1;
  while (frontier.length > 0 && chain.length < DIAGNOSIS_MAX_ITEMS) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const node = byId.get(id)!;
      next.push(...node.requires);
      if (isUnlocked(id)) continue;
      if (chain.length >= DIAGNOSIS_MAX_ITEMS) break;
      chain.push({
        node_id: id,
        name: node.name,
        depth,
        state: stateOf(id),
        failed_attempts: mastery.get(id)?.failed_attempts ?? 0,
      });
    }
    frontier = next;
    depth++;
  }
  return {
    node_id: nodeId,
    state: stateOf(nodeId),
    missing_prerequisites: chain.filter((item) =>
      missingDirect.includes(item.node_id)
    ),
    chain,
  };
}

/** 推荐理由（结构化；前端按 `code` 拼中文）。 */
export interface RecommendationReason {
  code:
    | "continue_learning"
    | "prerequisites_mastered"
    | "entry_point"
    | "review_prerequisite";
  params: Record<string, unknown>;
}

/** 一条推荐。 */
export interface Recommendation {
  node: {
    id: string;
    name: string;
    area: string;
    state: MasteryState;
    problem_count: number;
  };
  reason: RecommendationReason;
  /** 推荐题（复用 P2 阶梯「下一题」）；无推荐题时为 null。 */
  next: LadderItem | null;
}

/** 推荐数量上限。 */
export const RECOMMENDATIONS_MAX_LIMIT = 20;

/** 根因提示阈值：节点未达标提交次数不少于该值且存在未掌握前置。 */
export const ROOT_CAUSE_THRESHOLD = 3;

/** 推荐候选的顺序键（来自图视图的领域/节点 sort）。 */
export interface RecommendationOrder {
  area_sort: number;
  node_sort: number;
}

/**
 * 计算前沿节点推荐（纯函数）。
 *
 * 前沿 = 所有前置均已 `mastered`（无前置视为满足）、自身未 `mastered`、且在该
 * 域有可访问题目；另加根因提示：用户在节点上未达标 ≥ 3 次且存在未掌握前置 →
 * 推荐其未掌握前置（`review_prerequisite`）。
 *
 * 排序：`learning` 优先 → 根因提示 → 领域 sort → 节点 sort → ID。
 * 同一推荐节点只出现一次；`review_prerequisite` 指向前置节点。
 */
export function rankFrontierNodes(
  nodes: readonly KnowledgeGraphNode[],
  orderOf: (node: KnowledgeGraphNode) => RecommendationOrder,
  input: {
    stateOf: (nodeId: string) => MasteryState;
    failedOf: (nodeId: string) => number;
    countOf: (nodeId: string) => number;
    /** 节点未达标题数（`continue_learning` 的剩余题数用）。 */
    solvedOf: (nodeId: string) => number;
    /** 是否已通过摸底自评解锁（作为前置满足，非 learning 时不重复推荐基础题）。 */
    placedOf?: (nodeId: string) => boolean;
  },
): Array<{ node: KnowledgeGraphNode; reason: RecommendationReason }> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const isMastered = (id: string) => input.stateOf(id) === "mastered";
  const isPlaced = (id: string) => input.placedOf?.(id) ?? false;
  const isUnlocked = (id: string) => isMastered(id) || isPlaced(id);
  const candidates: Array<{
    rank: number;
    order: RecommendationOrder;
    node: KnowledgeGraphNode;
    reason: RecommendationReason;
  }> = [];
  const add = (
    rank: number,
    node: KnowledgeGraphNode,
    reason: RecommendationReason,
  ) => {
    candidates.push({ rank, order: orderOf(node), node, reason });
  };
  for (const node of nodes) {
    if (isMastered(node.id)) continue;
    const requires = node.requires.filter((id) => byId.has(id));
    const unmet = requires.filter((id) => !isUnlocked(id));
    const learning = input.stateOf(node.id) === "learning";
    if (!learning && isPlaced(node.id)) continue;
    if (unmet.length > 0) {
      // 根因提示：仅对「多次未达标」的节点推荐补前置（前置本身须未掌握且未自评）。
      if (
        input.stateOf(node.id) !== "learning" ||
        input.failedOf(node.id) < ROOT_CAUSE_THRESHOLD
      ) continue;
      for (const id of unmet) {
        const prerequisite = byId.get(id)!;
        if (isUnlocked(prerequisite.id)) continue;
        add(1, prerequisite, {
          code: "review_prerequisite",
          params: {
            node_id: node.id,
            node_name: node.name,
            failed_attempts: input.failedOf(node.id),
            prerequisite_id: prerequisite.id,
            prerequisite_name: prerequisite.name,
          },
        });
      }
      continue;
    }
    if (input.countOf(node.id) <= 0) continue;
    if (learning) {
      add(0, node, {
        code: "continue_learning",
        params: {
          node_id: node.id,
          node_name: node.name,
          remaining: Math.max(
            0,
            masteryMinSolved() - input.solvedOf(node.id),
          ),
        },
      });
    } else if (requires.length === 0) {
      add(2, node, {
        code: "entry_point",
        params: { node_id: node.id, node_name: node.name },
      });
    } else {
      add(2, node, {
        code: "prerequisites_mastered",
        params: {
          node_id: node.id,
          node_name: node.name,
          prerequisites: requires.map((id) => ({
            id,
            name: byId.get(id)!.name,
          })),
        },
      });
    }
  }
  candidates.sort((a, b) =>
    a.rank - b.rank ||
    a.order.area_sort - b.order.area_sort ||
    a.order.node_sort - b.order.node_sort ||
    (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0)
  );
  const seen = new Set<string>();
  const output: Array<
    { node: KnowledgeGraphNode; reason: RecommendationReason }
  > = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.node.id)) continue;
    seen.add(candidate.node.id);
    output.push({ node: candidate.node, reason: candidate.reason });
    if (output.length >= RECOMMENDATIONS_MAX_LIMIT) break;
  }
  return output;
}

/** 推荐视图（`GET /knowledge/me/recommendations` 的 `data`）。 */
export interface MyRecommendationsView {
  domain: { id: string; slug: string };
  items: Recommendation[];
}

/**
 * 用户在某域的推荐列表（前沿节点 + 根因提示，截断到 `limit`）。
 *
 * 每条推荐附该节点在该域的阶梯「下一题」（复用 P2，未登录不可用——本接口
 * 只对登录用户开放）。单节点访问失败时 `next` 为 null，不影响其他推荐。
 */
export async function readMyRecommendations(
  userId: string,
  domain: { id: string; slug: string },
  limit: number,
  db: DbRoot = getDb(),
): Promise<MyRecommendationsView> {
  const graph = await readKnowledgeGraph();
  const [mastery, placedIds, rows] = await Promise.all([
    loadUserMastery(userId, db),
    loadUserPlacementIds(userId, db),
    loadNodeProblems(db),
  ]);
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.domain_id !== domain.id) continue;
    counts.set(row.node_id, (counts.get(row.node_id) ?? 0) + 1);
  }
  const areaSort = new Map(graph.areas.map((area) => [area.id, area.sort]));
  const ranked = rankFrontierNodes(graph.nodes, (node) => ({
    area_sort: areaSort.get(node.area) ?? 0,
    // 图视图已按领域 sort、节点 sort 排序：用图中位置作为节点内次序。
    node_sort: graph.nodes.indexOf(node),
  }), {
    stateOf: (id) => mastery.get(id)?.state ?? "none",
    failedOf: (id) => mastery.get(id)?.failed_attempts ?? 0,
    countOf: (id) => counts.get(id) ?? 0,
    solvedOf: (id) => mastery.get(id)?.solved_count ?? 0,
    placedOf: (id) => placedIds.has(id),
  }).slice(0, limit);

  const viewer = userActorFromAuthenticatedId(userId);
  const items: Recommendation[] = [];
  for (const { node, reason } of ranked) {
    let next: LadderItem | null = null;
    try {
      next = (await readNodeLadder(node.id, domain.slug, viewer))?.next ??
        null;
    } catch {
      next = null;
    }
    items.push({
      node: {
        id: node.id,
        name: node.name,
        area: node.area,
        state: mastery.get(node.id)?.state ?? "none",
        problem_count: counts.get(node.id) ?? 0,
      },
      reason,
      next,
    });
  }
  return { domain, items };
}

// ── 覆盖度（实例管理员 / 域管理员）──────────────────────────

/** 单节点覆盖度（三档计数 + 缺口标记）。 */
export interface CoverageNodeItem {
  node_id: string;
  name: string;
  area: string;
  /** 三档（校准难度派生：<34 easy、<67 medium、其余 hard）计数。 */
  difficulty_distribution: { easy: number; medium: number; hard: number };
  problem_count: number;
  /** 题量不足：题数小于「已掌握」所需达标题数 K。 */
  insufficient_problems: boolean;
  /** 难度断层：无校准难度位于上三分之一的题目。 */
  difficulty_gap: boolean;
}

/** 覆盖度视图。 */
export interface CoverageView {
  /** 指定域时的域；未指定为 null（跨域汇总）。 */
  domain: { id: string; slug: string } | null;
  min_solved: number;
  totals: {
    nodes: number;
    nodes_with_problems: number;
    insufficient_problems: number;
    difficulty_gap: number;
    problems: number;
  };
  nodes: CoverageNodeItem[];
  /** 未归类题目数（该域已发布题目中无有效主知识点）。 */
  unclassified_problems: number;
  /** 待确认挂载数。 */
  pending_mappings: number;
  /** 失效挂载数（`deprecated` 节点上的有效挂载）。 */
  deprecated_mappings: number;
  /** 保护期内（进行中比赛 / 保密保护）被排除统计的题目数。 */
  protected_problems: number;
}

/**
 * 覆盖度面板（聚合 SQL 一次取数，不逐节点查询）。
 *
 * 保护期题目按 access 口径排除（与阶梯、掌握度一致）。`domainId` 为空时统计
 * 全部域（实例管理员视图）。
 */
export async function readCoverage(
  domain: { id: string; slug: string } | null,
  db: DbRoot = getDb(),
): Promise<CoverageView> {
  const graph = await readKnowledgeGraph();
  const rows = await loadNodeProblems(db);
  const scoped = domain
    ? rows.filter((row) => row.domain_id === domain.id)
    : rows;
  const protectedIds = await loadProtectedProblems(scoped);
  const visible = scoped.filter((row) => !protectedIds.has(row.problem_id));
  const byNode = new Map<string, number[]>();
  for (const row of visible) {
    const list = byNode.get(row.node_id) ?? [];
    list.push(scoreOfNodeProblem(row));
    byNode.set(row.node_id, list);
  }
  // 待确认挂载（pending）的题量计入「题量不足」判定，但不进难度分布、
  // 也不参与难度断层判定（难度未知，避免误报断层）。
  const byNodePending = new Map<string, number>();
  for (const row of await loadNodePendingCounts(db)) {
    if (domain && row.domain_id !== domain.id) continue;
    if (protectedIds.has(row.problem_id)) continue;
    byNodePending.set(
      row.node_id,
      (byNodePending.get(row.node_id) ?? 0) + 1,
    );
  }
  const minSolved = masteryMinSolved();
  const areaSort = new Map(graph.areas.map((area) => [area.id, area.sort]));
  const nodes: CoverageNodeItem[] = [];
  // 域视图只展开该域有题的知识点；实例管理员未指定域时展开全部节点。
  const nodesInDomain = domain
    ? new Set([
      ...scoped.map((row) => row.node_id),
      ...byNodePending.keys(),
    ])
    : null;
  for (const node of graph.nodes) {
    if (nodesInDomain && !nodesInDomain.has(node.id)) continue;
    const scores = byNode.get(node.id) ?? [];
    const pendingCount = byNodePending.get(node.id) ?? 0;
    const distribution = { easy: 0, medium: 0, hard: 0 };
    for (const score of scores) distribution[tierOf(score)]++;
    const problemCount = scores.length + pendingCount;
    const insufficient = problemCount < minSolved;
    nodes.push({
      node_id: node.id,
      name: node.name,
      area: node.area,
      difficulty_distribution: distribution,
      problem_count: problemCount,
      insufficient_problems: insufficient,
      // 难度断层：题量已足（题量不足另有标记）但没有一道「困难」档题目
      //（校准难度位于 0–100 的上三分之一）。不能用节点内相对上三分之一——
      // 一组题永远有相对最难的那几道，会让断层永远判不出来。
      difficulty_gap: !insufficient && scores.length > 0 &&
        distribution.hard === 0,
    });
  }
  nodes.sort((a, b) =>
    (areaSort.get(a.area) ?? 0) - (areaSort.get(b.area) ?? 0) ||
    graph.nodes.findIndex((node) => node.id === a.node_id) -
      graph.nodes.findIndex((node) => node.id === b.node_id)
  );

  const domainFilter = domain ? sql`AND p.domain_id = ${domain.id}` : sql``;
  const counts = await db.execute<{
    unclassified_problems: number;
    pending_mappings: number;
    deprecated_mappings: number;
  }>(sql`
    WITH candidate AS (
      SELECT p.id
      FROM problems p
      JOIN domains d ON d.id = p.domain_id
      JOIN domain_problem_bindings b
        ON b.domain_id = p.domain_id AND b.problem_id = p.id
      WHERE p.latest_version_id IS NOT NULL
        AND b.disabled_at IS NULL
        AND d.status <> 'suspended'
        ${domainFilter}
    )
    SELECT
      (SELECT count(*)::int FROM candidate c
        WHERE NOT EXISTS (
          SELECT 1 FROM problem_knowledge pk
          WHERE pk.problem_id = c.id AND pk.role = 'primary'
            AND pk.review_status IN ('auto', 'confirmed', 'pending')
        )) AS unclassified_problems,
      (SELECT count(DISTINCT pk.problem_id)::int FROM problem_knowledge pk
        JOIN candidate c ON c.id = pk.problem_id
        WHERE pk.review_status = 'pending') AS pending_mappings,
      (SELECT count(*)::int FROM problem_knowledge pk
        JOIN problems p ON p.id = pk.problem_id
        JOIN knowledge_nodes kn ON kn.id = pk.node_id
        WHERE pk.review_status IN ('auto', 'confirmed')
          AND kn.status = 'deprecated'
          ${domainFilter}) AS deprecated_mappings
  `);
  const totals_ = (unwrapRows(counts as never) as {
    unclassified_problems: number;
    pending_mappings: number;
    deprecated_mappings: number;
  }[])[0] ?? {
    unclassified_problems: 0,
    pending_mappings: 0,
    deprecated_mappings: 0,
  };
  return {
    domain,
    min_solved: minSolved,
    totals: {
      nodes: nodes.length,
      nodes_with_problems:
        nodes.filter((node) => node.problem_count > 0).length,
      insufficient_problems:
        nodes.filter((node) => node.insufficient_problems).length,
      difficulty_gap: nodes.filter((node) => node.difficulty_gap).length,
      problems: nodes.reduce((sum, node) => sum + node.problem_count, 0),
    },
    nodes,
    unclassified_problems: totals_.unclassified_problems,
    pending_mappings: totals_.pending_mappings,
    deprecated_mappings: totals_.deprecated_mappings,
    protected_problems: scoped.length - visible.length,
  };
}
