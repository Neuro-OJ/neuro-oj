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
  applyForgettingDecay,
  computeNodeMastery,
  computeScoreRatio,
  DEFAULT_MASTERY_MIN_SOLVED,
  type KnowledgeMappingRole,
  type MasteryState,
  type NodeMasteryInput,
  type NodeMasteryResult,
  type ProblemAbilityObservation,
  upperThirdThreshold,
} from "./ability.ts";
import {
  isPassingScore,
  type LadderItem,
  readNodeLadder,
  tierToPrior,
} from "./difficulty.ts";
import { type KnowledgeGraphNode, readKnowledgeGraph } from "./graph.ts";
import { objectiveFullScore } from "./objective-full-score.ts";
export {
  type CoverageNodeItem,
  type CoverageView,
  readCoverage,
} from "./coverage.ts";

export {
  computeNodeMastery,
  DEFAULT_MASTERY_MIN_SOLVED,
  type MasteryState,
  type NodeMasteryInput,
  type NodeMasteryResult,
  upperThirdThreshold,
};

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

type NodeProblemMappingRow = NodeProblemRow & {
  role: KnowledgeMappingRole;
};

/** 某用户在某题上的有效成绩（最高分）、对应作答时间与未达标提交数。 */
interface UserProblemScore {
  /** 有效成绩最高分（×100 记分；无有效成绩为空）。 */
  best: number | null;
  /** 达到有效最高分的最近一次作答/评测完成时间（ISO 8601；无有效成绩为空）。 */
  best_at: string | null;
  /** 未达标提交次数（全部正式提交中未达标的尝试数）。 */
  failed_attempts: number;
}

type UserScoreRow = {
  problem_id: string;
  kind: string;
  best: number | null;
  best_at: string | null;
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
 * 节点题目行（含主/次知识点，供掌握度 Elo 能力分与协同证据累计使用）。
 */
async function loadNodeProblemMappings(
  db: DbRoot = getDb(),
): Promise<NodeProblemMappingRow[]> {
  const rows = await db.execute<NodeProblemMappingRow>(sql`
    SELECT pk.node_id, pk.role, p.id AS problem_id, p.domain_id, d.slug,
           p.is_objective, pd.pass_ratio_override, p.difficulty, pd.calibrated
    FROM problem_knowledge pk
    JOIN knowledge_nodes kn ON kn.id = pk.node_id AND kn.status = 'active'
    JOIN problems p ON p.id = pk.problem_id
    JOIN domains d ON d.id = p.domain_id
    JOIN domain_problem_bindings b
      ON b.domain_id = p.domain_id AND b.problem_id = p.id
    LEFT JOIN problem_difficulty pd ON pd.problem_id = p.id
    WHERE pk.role IN ('primary', 'secondary')
      AND pk.review_status IN ('auto', 'confirmed')
      AND b.disabled_at IS NULL
      AND d.status <> 'suspended'
      AND p.latest_version_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM problem_versions v WHERE v.problem_id = p.id
        AND v.id = CASE WHEN p.effective_version_mode = 'exact'
          THEN p.required_version_id ELSE p.latest_version_id END)
  `);
  return unwrapRows(rows as never) as NodeProblemMappingRow[];
}

/** 节点题目难度分（无校准行用先验）。 */
export function scoreOfNodeProblem(row: NodeProblemRow): number {
  return row.calibrated ?? tierToPrior(row.difficulty);
}

/**
 * 用户在特定题目集合上的有效成绩（练习 + 已结束比赛）、对应时间与未达标次数。
 *
 * `best` 为分题型（普通提交 / 客观题套卷）的最高有效分，`best_at` 为达到该最高分
 * 的最近一次作答时间；未达标次数按全部正式提交统计。
 */
export async function loadUserProblemScores(
  userId: string,
  problemIds: string[],
  db: DbRoot = getDb(),
): Promise<Map<string, UserProblemScore>> {
  const result = new Map<string, UserProblemScore>();
  if (problemIds.length === 0) return result;
  const uniqueIds = [...new Set(problemIds)];
  const ids = sql.join(uniqueIds.map((id) => sql`${id}`), sql`, `);
  const rows = await db.execute<UserScoreRow>(sql`
    WITH eff AS (
      SELECT s.problem_id, 'submission' AS kind, a.score, a.accepted, s.contest_id,
             COALESCE(a.finished_at, a.created_at, s.created_at) AS attempt_at
      FROM submissions s
      JOIN evaluation_attempts a ON a.id = s.effective_attempt_id
      WHERE s.user_id = ${userId} AND s.problem_id IN (${ids})
      UNION ALL
      SELECT o.paper_id AS problem_id, 'objective' AS kind,
             a.score, a.accepted, o.contest_id,
             COALESCE(a.finished_at, a.created_at, o.created_at) AS attempt_at
      FROM objective_submissions o
      JOIN evaluation_attempts a ON a.id = o.effective_attempt_id
      WHERE o.user_id = ${userId} AND o.paper_id IN (${ids})
    ),
    elig AS (
      SELECT e.problem_id, e.kind, e.score, e.accepted, e.attempt_at,
             (e.contest_id IS NULL OR (
               c.end_time ~ ${CONTEST_TIME_REGEX}
               AND pg_input_is_valid(c.end_time, 'timestamptz')
               AND c.end_time::timestamptz <= now()
             )) AS is_eligible
      FROM eff e
      LEFT JOIN contests c ON c.id = e.contest_id
    ),
    agg AS (
      SELECT problem_id, kind,
             count(*) FILTER (WHERE NOT accepted)::int AS failed_attempts,
             max(score) FILTER (WHERE is_eligible) AS best
      FROM elig
      GROUP BY problem_id, kind
    )
    SELECT a.problem_id, a.kind, a.failed_attempts, a.best,
           (SELECT max(e2.attempt_at) FROM elig e2
            WHERE e2.problem_id = a.problem_id
              AND e2.kind = a.kind
              AND e2.is_eligible
              AND e2.score = a.best) AS best_at
    FROM agg a
  `);
  for (const row of unwrapRows(rows as never) as UserScoreRow[]) {
    // 同一题目可能同时有普通提交与客观题套卷成绩：合并为该题的最高分与失败数。
    const previous = result.get(row.problem_id);
    let best: number | null;
    let bestAt: string | null;
    if (previous?.best == null) {
      best = row.best;
      bestAt = row.best_at ?? null;
    } else if (row.best == null) {
      best = previous.best;
      bestAt = previous.best_at;
    } else if (row.best > previous.best) {
      best = row.best;
      bestAt = row.best_at ?? null;
    } else if (row.best < previous.best) {
      best = previous.best;
      bestAt = previous.best_at;
    } else {
      best = previous.best;
      bestAt = previous.best_at && row.best_at
        ? (previous.best_at >= row.best_at ? previous.best_at : row.best_at)
        : (row.best_at ?? previous.best_at);
    }
    result.set(row.problem_id, {
      best,
      best_at: bestAt,
      failed_attempts: Math.max(
        previous?.failed_attempts ?? 0,
        row.failed_attempts,
      ),
    });
  }
  return result;
}

/** 比赛保密保护中的题目 ID 集合（进行中 + 未结束保护；口径见 access）。 */
export async function loadProtectedProblems(
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
  const rows = await loadNodeProblemMappings(db);
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

  /** 节点 → 主知识点题目（难度/计数）与主/次作答观测。 */
  const perNode = new Map<string, {
    difficulties: number[];
    passed: number[];
    solved: number;
    attempted: number;
    failed: number;
    observations: ProblemAbilityObservation[];
  }>();
  for (const row of rows) {
    const agg = perNode.get(row.node_id) ?? {
      difficulties: [],
      passed: [],
      solved: 0,
      attempted: 0,
      failed: 0,
      observations: [],
    };
    perNode.set(row.node_id, agg);
    if (protectedIds.has(row.problem_id)) continue;
    const difficulty = scoreOfNodeProblem(row);
    if (row.role === "primary") {
      agg.difficulties.push(difficulty);
    }
    const mine = scores.get(row.problem_id);
    if (!mine) continue;
    if (row.role === "primary") {
      agg.failed += mine.failed_attempts;
    }
    if (mine.best !== null) {
      const passOption = await passOptionOf(row, fullScores);
      const passed = isPassingScore(mine.best, passOption);
      const scoreRatio = computeScoreRatio(mine.best, passOption);
      if (row.role === "primary") {
        agg.attempted++;
        if (passed) {
          agg.passed.push(difficulty);
          agg.solved++;
        }
      }
      agg.observations.push({
        problem_id: row.problem_id,
        role: row.role,
        difficulty,
        score_ratio: scoreRatio,
        passed,
        attempted_at: mine.best_at,
      });
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
    const touched = agg.attempted > 0 || agg.failed > 0 ||
      agg.observations.length > 0;
    if (!touched) continue;
    keep.add(nodeId);
    const result = computeNodeMastery({
      total: agg.difficulties.length,
      passed_difficulties: agg.passed,
      difficulties: agg.difficulties,
      solved_count: agg.solved,
      attempted_count: agg.attempted,
      failed_attempts: agg.failed,
      observations: agg.observations,
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
        WHERE pk.problem_id = p.id AND pk.role IN ('primary', 'secondary')
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

/** 持久化掌握度记录。 */
export interface UserMasteryRecord {
  state: MasteryState;
  solved_count: number;
  attempted_count: number;
  failed_attempts: number;
  max_passed_difficulty: number | null;
  ability_score: number;
  evidence_weight: number;
  last_passed_at: string | null;
  updated_at: string;
}

/** 读取某用户全部掌握度记录（API 与推荐共用）。 */
export async function loadUserMastery(
  userId: string,
  db: DbRoot = getDb(),
): Promise<Map<string, UserMasteryRecord>> {
  const rows = await db.select().from(userKnowledgeMastery).where(
    eq(userKnowledgeMastery.user_id, userId),
  );
  const map = new Map<string, UserMasteryRecord>();
  for (const row of rows) {
    map.set(row.node_id, {
      state: row.state as MasteryState,
      solved_count: row.solved_count,
      attempted_count: row.attempted_count,
      failed_attempts: row.failed_attempts,
      max_passed_difficulty: row.max_passed_difficulty,
      ability_score: row.ability_score ?? 0,
      evidence_weight: Math.round((row.evidence_weight ?? 0) * 100) / 100,
      last_passed_at: row.last_passed_at ?? null,
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
  /** 持久化 Elo 能力分（0–100 整数）。 */
  ability_score: number;
  /** 读时遗忘衰减后的展示能力分（0–100 整数，不写库）。 */
  effective_ability: number;
  /** 有效加权证据量（保留 2 位小数）。 */
  evidence_weight: number;
  /** 是否触发遗忘复习提醒（读时计算，不写库）。 */
  needs_review: boolean;
  /** 最近一次达标时间（ISO 8601，可空）。 */
  last_passed_at: string | null;
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
 * `domainId` 为空时不按域过滤（`domain` 为 null）。读时基于 `now - last_passed_at`
 * 实时计算 `effective_ability` 与 `needs_review`，不写回数据库。
 */
export async function readMyMastery(
  userId: string,
  domain: { id: string; slug: string } | null,
  db: DbRoot = getDb(),
  now: Date = new Date(),
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
    const state = record?.state ?? "none";
    const abilityScore = record?.ability_score ?? 0;
    const lastPassedAt = record?.last_passed_at ?? null;
    const decayed = applyForgettingDecay(
      { ability_score: abilityScore, state, last_passed_at: lastPassedAt },
      now,
    );
    items.push({
      node_id: node.id,
      name: node.name,
      area: node.area,
      state,
      solved_count: record?.solved_count ?? 0,
      attempted_count: record?.attempted_count ?? 0,
      failed_attempts: record?.failed_attempts ?? 0,
      max_passed_difficulty: record?.max_passed_difficulty ?? null,
      ability_score: decayed.ability_score,
      effective_ability: decayed.effective_ability,
      evidence_weight: record?.evidence_weight ?? 0,
      needs_review: decayed.needs_review,
      last_passed_at: lastPassedAt,
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
    | "review_prerequisite"
    | "needs_review";
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
    ability_score: number;
    effective_ability: number;
    needs_review: boolean;
  };
  reason: RecommendationReason;
  /** 推荐题（复用 P2 阶梯「下一题」并优先匹配目标难度）；无推荐题时为 null。 */
  next: LadderItem | null;
}

/** 推荐数量上限。 */
export const RECOMMENDATIONS_MAX_LIMIT = 20;

/** 根因提示阈值：节点未达标提交次数不少于该值且存在未掌握前置。 */
export const ROOT_CAUSE_THRESHOLD = 3;

/** 推荐选题时的能力分微挑战偏移量（`d ≈ effective_ability + 5`）。 */
export const RECOMMENDATION_TARGET_OFFSET = 5;

/** 推荐候选的顺序键（来自图视图的领域/节点 sort）。 */
export interface RecommendationOrder {
  area_sort: number;
  node_sort: number;
}

/**
 * 计算前沿节点推荐（纯函数）。
 *
 * 前沿 = 所有前置均已 `mastered`（或已自评解锁，无前置视为满足）、自身未 `mastered`、
 * 且在该域有可访问题目；另含两类唤醒：
 * - 根因提示：用户在未掌握节点上未达标 ≥ 3 次（含 `state === 'none'` 零通过场景）
 *   且存在未掌握前置 → 推荐其未掌握前置（`review_prerequisite`）；
 * - 遗忘复习：已掌握节点触发读时 `needs_review` 且本域有题 → 唤醒复习（`needs_review`）。
 *
 * 排序：`learning`（0）→ 根因提示（1）→ 遗忘复习（2）→ 新前沿节点（3）→ 领域 sort → 节点 sort → ID。
 * 同一推荐节点只出现一次；`review_prerequisite` 指向前置节点。
 */
export function rankFrontierNodes(
  nodes: readonly KnowledgeGraphNode[],
  orderOf: (node: KnowledgeGraphNode) => RecommendationOrder,
  input: {
    stateOf: (nodeId: string) => MasteryState;
    failedOf: (nodeId: string) => number;
    countOf: (nodeId: string) => number;
    /** 节点已达标题数（`continue_learning` 的剩余题数用）。 */
    solvedOf: (nodeId: string) => number;
    /** 是否已通过摸底自评解锁（作为前置满足，非 learning 时不重复推荐基础题）。 */
    placedOf?: (nodeId: string) => boolean;
    /** 是否触发读时遗忘复习提醒（唤醒已掌握节点进入复习推荐）。 */
    needsReviewOf?: (nodeId: string) => boolean;
    /** 可选：原始能力分（透传给 `needs_review` 理由参数）。 */
    abilityOf?: (nodeId: string) => number;
    /** 可选：衰减后能力分（透传给 `needs_review` 理由参数）。 */
    effectiveAbilityOf?: (nodeId: string) => number;
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
    if (isMastered(node.id)) {
      if (input.needsReviewOf?.(node.id) && input.countOf(node.id) > 0) {
        add(2, node, {
          code: "needs_review",
          params: {
            node_id: node.id,
            node_name: node.name,
            ability_score: input.abilityOf?.(node.id) ?? 0,
            effective_ability: input.effectiveAbilityOf?.(node.id) ?? 0,
          },
        });
      }
      continue;
    }
    const requires = node.requires.filter((id) => byId.has(id));
    const unmet = requires.filter((id) => !isUnlocked(id));
    const learning = input.stateOf(node.id) === "learning";
    if (unmet.length > 0) {
      // 根因提示：对未掌握且多次未达标的节点（包含 state === 'none' 零通过但多次失败）推荐补前置。
      if (input.failedOf(node.id) < ROOT_CAUSE_THRESHOLD) continue;
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
    if (!learning && isPlaced(node.id)) continue;
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
      add(3, node, {
        code: "entry_point",
        params: { node_id: node.id, node_name: node.name },
      });
    } else {
      add(3, node, {
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

/** 复习节点在全部题已达标时的回退选题：挑最接近当前展示能力分的复习题。 */
function pickReviewFallbackItem(
  items: readonly LadderItem[],
  targetDifficulty: number,
): LadderItem | null {
  if (items.length === 0) return null;
  let best = items[0]!;
  let bestDist = Math.abs(best.difficulty - targetDifficulty);
  for (let i = 1; i < items.length; i++) {
    const item = items[i]!;
    const dist = Math.abs(item.difficulty - targetDifficulty);
    if (
      dist < bestDist ||
      (dist === bestDist && item.difficulty > best.difficulty)
    ) {
      best = item;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * 用户在某域的推荐列表（前沿节点 + 根因提示 + 遗忘复习唤醒，截断到 `limit`）。
 *
 * 每条推荐附该节点在该域的阶梯「下一题」（有能力分时优先匹配接近
 * `effective_ability + 5` 的未达标题；保护期过滤沿用 P2）。单节点访问失败时
 * `next` 为 null，不影响其他推荐。
 */
export async function readMyRecommendations(
  userId: string,
  domain: { id: string; slug: string },
  limit: number,
  db: DbRoot = getDb(),
  now: Date = new Date(),
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
  const decayByNode = new Map<
    string,
    { ability_score: number; effective_ability: number; needs_review: boolean }
  >();
  for (const [nodeId, record] of mastery) {
    const decayed = applyForgettingDecay(
      {
        ability_score: record.ability_score,
        state: record.state,
        last_passed_at: record.last_passed_at,
      },
      now,
    );
    decayByNode.set(nodeId, {
      ability_score: decayed.ability_score,
      effective_ability: decayed.effective_ability,
      needs_review: decayed.needs_review,
    });
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
    needsReviewOf: (id) => decayByNode.get(id)?.needs_review ?? false,
    abilityOf: (id) => decayByNode.get(id)?.ability_score ?? 0,
    effectiveAbilityOf: (id) => decayByNode.get(id)?.effective_ability ?? 0,
  }).slice(0, limit);

  const viewer = userActorFromAuthenticatedId(userId);
  const items: Recommendation[] = [];
  for (const { node, reason } of ranked) {
    const decayed = decayByNode.get(node.id);
    const abilityScore = decayed?.ability_score ?? 0;
    const effectiveAbility = decayed?.effective_ability ?? 0;
    const targetDifficulty = abilityScore > 0
      ? Math.min(100, effectiveAbility + RECOMMENDATION_TARGET_OFFSET)
      : undefined;
    let next: LadderItem | null = null;
    try {
      const ladder = await readNodeLadder(node.id, domain.slug, viewer, {
        targetDifficulty,
      });
      next = ladder?.next ?? null;
      if (
        next === null &&
        reason.code === "needs_review" &&
        ladder &&
        ladder.items.length > 0
      ) {
        next = pickReviewFallbackItem(ladder.items, effectiveAbility);
      }
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
        ability_score: abilityScore,
        effective_ability: effectiveAbility,
        needs_review: decayed?.needs_review ?? false,
      },
      reason,
      next,
    });
  }
  return { domain, items };
}
