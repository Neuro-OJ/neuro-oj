import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "./../../../shared/base/errors.ts";
import { unwrapRows } from "./../../../shared/base/sql-rows.ts";
import type {
  ContestType,
  KaggleProblemScore,
  KaggleRankingRow,
  RankingVisibility,
} from "./../types/contests.ts";
import { getContest } from "./contests.ts";
import { contestRankingSnapshots } from "../../../shared/db/schema.ts";
import { logAudit } from "../../system/index.ts";

export async function publishContestRankingSnapshot(
  contestId: string,
  actorId: string,
  note = "",
  options: { allowFailed?: boolean } = {},
): Promise<
  { id: string; version: number; rows: KaggleRankingRow[]; created_at: string }
> {
  const contest = await getContest(contestId);
  if (contest.status !== "ended") {
    throw new ConflictError("竞赛尚未结束，不能发布正式成绩");
  }
  const settlement = await getContestSettlementStatus(contestId);
  if (settlement.pending_count > 0) {
    throw new ConflictError(
      `仍有 ${settlement.pending_count} 条评测待处理，请完成评测后再结算`,
    );
  }
  if (
    settlement.failed_count > 0 &&
    (!options.allowFailed || !note.trim())
  ) {
    throw new ConflictError(
      `发现 ${settlement.failed_count} 条失败评测；请处理失败任务，或填写说明并明确允许带失败评测发布`,
    );
  }
  const db = getDb();
  const rows = await getKaggleRanking(contestId);
  const created_at = new Date().toISOString();
  const id = crypto.randomUUID();
  const version = await db.transaction(async (tx) => {
    // 锁定竞赛行，串行化同一竞赛的版本分配，避免 max(version)+1 竞态。
    await tx.execute(
      sql`SELECT id FROM contests WHERE id = ${contestId} FOR UPDATE`,
    );
    const [latest] = await tx.select({
      version: contestRankingSnapshots.version,
    })
      .from(contestRankingSnapshots)
      .where(eq(contestRankingSnapshots.contest_id, contestId))
      .orderBy(desc(contestRankingSnapshots.version)).limit(1);
    const nextVersion = (latest?.version ?? 0) + 1;
    await tx.insert(contestRankingSnapshots).values({
      id,
      contest_id: contest.id,
      version: nextVersion,
      status: "published",
      note,
      rows,
      created_by: actorId,
      created_at,
    });
    return nextVersion;
  });
  await logAudit("contest.ranking_snapshot", {
    action: "contest.ranking_snapshot",
    contest_id: contestId,
    version,
    note,
    previous_version: version > 1 ? version - 1 : null,
    failed_count: settlement.failed_count,
  }, { type: "contest", id: contestId });
  return { id, version, rows, created_at };
}

export interface ContestSettlementItem {
  submission_id: string;
  user_id: string;
  username: string;
  problem_id: string;
  problem_title: string;
  status: string;
  result_status: string | null;
  created_at: string;
  kind: "submission" | "objective";
}

export interface ContestSettlementStatus {
  contest_id: string;
  contest_status: "pending" | "running" | "ended";
  pending_count: number;
  failed_count: number;
  ready: boolean;
  items: ContestSettlementItem[];
  truncated: boolean;
}

/**
 * 读取结算门禁状态。pending/judging、缺失结果均属于待处理；error 属于失败。
 * 该查询只读，不会改变队列或提交状态，管理员可据此决定处理或带说明发布。
 */
export async function getContestSettlementStatus(
  contestId: string,
): Promise<ContestSettlementStatus> {
  const contest = await getContest(contestId);
  const db = getDb();
  const result = await db.execute(sql`
    WITH contest_tasks AS (
      SELECT s.id AS submission_id, s.user_id, u.username, s.problem_id,
        p.title AS problem_title, s.status,
        er.status AS result_status, s.created_at, 'submission'::text AS kind
      FROM submissions s
      JOIN users u ON u.id = s.user_id
      JOIN problems p ON p.id = s.problem_id
      LEFT JOIN evaluation_results er ON er.submission_id = s.id
      WHERE s.contest_id = ${contestId}
      UNION ALL
      SELECT os.id AS submission_id, os.user_id, u.username, os.paper_id,
        p.title AS problem_title, os.status,
        os.status AS result_status, os.created_at, 'objective'::text AS kind
      FROM objective_submissions os
      JOIN users u ON u.id = os.user_id
      JOIN problems p ON p.id = os.paper_id
      WHERE os.contest_id = ${contestId}
    )
    SELECT
      COUNT(*) FILTER (WHERE status IN ('pending', 'judging')
        OR result_status IS NULL
        OR result_status NOT IN ('finished', 'error'))::int AS pending_count,
      COUNT(*) FILTER (WHERE status = 'error' OR result_status = 'error')::int
        AS failed_count
    FROM contest_tasks
  `);
  const [counts] = unwrapRows<Record<string, unknown>>(result as never);
  const pendingCount = Number(counts?.pending_count ?? 0);
  const failedCount = Number(counts?.failed_count ?? 0);
  const itemResult = await db.execute(sql`
    WITH contest_tasks AS (
      SELECT s.id AS submission_id, s.user_id, u.username, s.problem_id,
        p.title AS problem_title, s.status,
        er.status AS result_status, s.created_at, 'submission'::text AS kind
      FROM submissions s
      JOIN users u ON u.id = s.user_id
      JOIN problems p ON p.id = s.problem_id
      LEFT JOIN evaluation_results er ON er.submission_id = s.id
      WHERE s.contest_id = ${contestId}
      UNION ALL
      SELECT os.id AS submission_id, os.user_id, u.username, os.paper_id,
        p.title AS problem_title, os.status,
        os.status AS result_status, os.created_at, 'objective'::text AS kind
      FROM objective_submissions os
      JOIN users u ON u.id = os.user_id
      JOIN problems p ON p.id = os.paper_id
      WHERE os.contest_id = ${contestId}
    )
    SELECT submission_id, user_id, username, problem_id, problem_title,
      status, result_status, created_at, kind
    FROM contest_tasks
    WHERE status IN ('pending', 'judging', 'error')
      OR result_status IS NULL
      OR result_status NOT IN ('finished', 'error')
      OR result_status = 'error'
    ORDER BY created_at ASC, submission_id ASC
    LIMIT 500
  `);
  const items = unwrapRows<Record<string, unknown>>(itemResult as never).map(
    (row) => ({
      submission_id: String(row.submission_id),
      user_id: String(row.user_id),
      username: String(row.username),
      problem_id: String(row.problem_id),
      problem_title: String(row.problem_title),
      status: String(row.status),
      result_status: row.result_status === null
        ? null
        : String(row.result_status),
      created_at: String(row.created_at),
      kind: row.kind === "objective"
        ? "objective" as const
        : "submission" as const,
    }),
  );
  return {
    contest_id: contestId,
    contest_status: contest.status,
    pending_count: pendingCount,
    failed_count: failedCount,
    ready: contest.status === "ended" && pendingCount === 0,
    items,
    truncated: items.length >= 500,
  };
}

export async function getLatestContestRankingSnapshot(contestId: string) {
  const [snapshot] = await getDb().select().from(contestRankingSnapshots)
    .where(eq(contestRankingSnapshots.contest_id, contestId))
    .orderBy(desc(contestRankingSnapshots.version)).limit(1);
  return snapshot ?? null;
}

/** 返回竞赛全部正式成绩版本，供修订历史和审计核对使用。 */
export async function listContestRankingSnapshots(contestId: string) {
  await getContest(contestId);
  return await getDb().select({
    id: contestRankingSnapshots.id,
    contest_id: contestRankingSnapshots.contest_id,
    version: contestRankingSnapshots.version,
    status: contestRankingSnapshots.status,
    note: contestRankingSnapshots.note,
    created_by: contestRankingSnapshots.created_by,
    created_at: contestRankingSnapshots.created_at,
  }).from(contestRankingSnapshots)
    .where(eq(contestRankingSnapshots.contest_id, contestId))
    .orderBy(desc(contestRankingSnapshots.version));
}

/**
 * 将可能为数组或 JSON 字符串的值解析为数组（解析失败或类型不符时返回空数组）。
 *
 * @param value 待解析的值
 * @returns 解析后的元素数组
 */
function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 类 Kaggle 排名计算。
 *
 * 规则：
 * - 每题取历史最高分（同分取最早）
 * - 总分 = Σ(每题最高分)
 * - 平局按“最后一次严格刷新最高分的提交时间”早者优先；同分提交不算刷新
 * - 前三字段均相同时按 registered_at ASC, user_id ASC 稳定排序
 */
export async function getKaggleRanking(
  contestId: string,
  cutoffTime?: string,
): Promise<KaggleRankingRow[]> {
  const contest = await getContest(contestId);
  if (contest.type !== "kaggle") {
    throw new BadRequestError("该竞赛不是类 Kaggle 赛制");
  }
  const db = getDb();
  const result = await db.execute(sql`
    WITH contest_data AS (
      SELECT id, start_time, end_time
      FROM contests
      WHERE id = ${contestId}
    ),
    submission_scores AS (
      SELECT s.id, s.user_id, s.problem_id, s.created_at, er.score,
        er.status AS evaluation_status, er.created_at AS evaluation_created_at,
        s.rejudge_seq
      FROM submissions s
      JOIN evaluation_results er ON er.submission_id = s.id
      JOIN contest_data c ON c.id = s.contest_id
      WHERE s.contest_id = ${contestId}
        AND s.created_at <= c.end_time
        ${cutoffTime ? sql`AND s.created_at <= ${cutoffTime}` : sql``}
      UNION ALL
      SELECT os.id, os.user_id, os.paper_id, os.created_at, os.score,
        os.status AS evaluation_status, os.created_at AS evaluation_created_at,
        0 AS rejudge_seq
      FROM objective_submissions os
      JOIN contest_data c ON c.id = os.contest_id
      WHERE os.contest_id = ${contestId}
        AND os.created_at <= c.end_time
        ${cutoffTime ? sql`AND os.created_at <= ${cutoffTime}` : sql``}
    ),
    ranked AS (
      SELECT
        id,
        user_id,
        problem_id,
        created_at,
        score,
        evaluation_status,
        evaluation_created_at,
        rejudge_seq,
        MAX(score) OVER (
          PARTITION BY user_id, problem_id
          ORDER BY created_at ASC, id ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS prev_max
      FROM submission_scores
    ),
    refresh_times AS (
      SELECT user_id, problem_id, MAX(created_at) AS last_refresh_at
      FROM ranked
      WHERE prev_max IS NULL OR score > prev_max
      GROUP BY user_id, problem_id
    ),
    best_rows AS (
      SELECT
        id,
        user_id,
        problem_id,
        created_at,
        score,
        rejudge_seq,
        evaluation_status,
        evaluation_created_at,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, problem_id
          ORDER BY score DESC, created_at ASC, id ASC
        ) AS rn
      FROM submission_scores
    ),
    best_scores AS (
      SELECT
        user_id,
        problem_id,
        score AS best_score,
        created_at AS last_best_at,
        id AS submission_id,
        rejudge_seq,
        evaluation_status,
        evaluation_created_at
      FROM best_rows
      WHERE rn = 1
    ),
    attempts AS (
      SELECT user_id, problem_id, COUNT(*)::int AS attempts
      FROM submission_scores
      GROUP BY user_id, problem_id
    ),
    problem_stats AS (
      SELECT
        participant.user_id,
        participant.registered_at,
        cp.problem_id,
        cp.label,
        cp.sort_order,
        COALESCE(bs.best_score, 0)::int AS best_score,
        COALESCE(at.attempts, 0)::int AS attempts,
        bs.last_best_at,
        bs.submission_id,
        bs.rejudge_seq,
        bs.evaluation_status,
        bs.evaluation_created_at,
        rt.last_refresh_at
      FROM contest_participants participant
      CROSS JOIN contest_problems cp
      LEFT JOIN best_scores bs
        ON bs.user_id = participant.user_id
        AND bs.problem_id = cp.problem_id
      LEFT JOIN attempts at
        ON at.user_id = participant.user_id
        AND at.problem_id = cp.problem_id
      LEFT JOIN refresh_times rt
        ON rt.user_id = participant.user_id
        AND rt.problem_id = cp.problem_id
      WHERE participant.contest_id = ${contestId}
        AND cp.contest_id = ${contestId}
    ),
    user_totals AS (
      SELECT
        ps.user_id,
        ps.registered_at,
        SUM(ps.best_score)::int AS total_score,
        MAX(ps.last_refresh_at) AS last_submission_at,
        jsonb_agg(
          jsonb_build_object(
            'label', ps.label,
            'best_score', ps.best_score,
            'attempts', ps.attempts,
            'last_best_at', ps.last_best_at,
            'submission_id', ps.submission_id,
            'rejudge_seq', ps.rejudge_seq,
            'evaluation_status', ps.evaluation_status,
            'evaluation_created_at', ps.evaluation_created_at
          ) ORDER BY ps.sort_order, ps.label
        ) AS problem_scores
      FROM problem_stats ps
      GROUP BY ps.user_id, ps.registered_at
    )
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY
          ut.total_score DESC,
          ut.last_submission_at ASC NULLS LAST,
          ut.registered_at ASC,
          ut.user_id ASC
      )::int AS rank,
      ut.user_id,
      u.username,
      u.avatar_url,
      ut.total_score,
      ut.last_submission_at,
      ut.problem_scores
    FROM user_totals ut
    JOIN users u ON u.id = ut.user_id
    ORDER BY rank
  `);

  return unwrapRows<Record<string, unknown>>(result as never).map((row) => ({
    rank: Number(row.rank),
    user_id: row.user_id as string,
    username: row.username as string,
    avatar_url: (row.avatar_url as string | null) ?? null,
    total_score: Number(row.total_score),
    last_submission_at: row.last_submission_at === null
      ? null
      : String(row.last_submission_at),
    problem_scores: parseJsonArray<KaggleProblemScore>(row.problem_scores),
  }));
}

export type ContestRankingView = "live" | "frozen" | "official";

export interface ContestRankingResult {
  rows: KaggleRankingRow[];
  view: ContestRankingView;
  ranking_visibility: RankingVisibility;
  freeze_start_time: string | null;
  freeze_end_time: string;
  settlement_pending: boolean;
}

/** 统一计算封榜边界，起点包含、终点不包含。 */
export function getContestFreezeWindow(contest: {
  end_time: string;
  freeze_start_time: string | null;
  freeze_duration_seconds: number;
}): { start: string | null; end: string } {
  const end = new Date(contest.end_time).toISOString();
  if (contest.freeze_start_time) {
    return { start: new Date(contest.freeze_start_time).toISOString(), end };
  }
  if (contest.freeze_duration_seconds <= 0) return { start: null, end };
  const startMs = Date.parse(contest.end_time) -
    contest.freeze_duration_seconds * 1000;
  return { start: new Date(startMs).toISOString(), end };
}

function isContestFrozen(
  window: { start: string | null; end: string },
  now = Date.now(),
): boolean {
  if (!window.start) return false;
  return now >= Date.parse(window.start) && now < Date.parse(window.end);
}

function assertRankingVisibility(
  visibility: RankingVisibility,
  isAdmin: boolean,
  viewerId: string | undefined,
  registered: boolean,
): void {
  if (isAdmin) return;
  if (visibility === "hidden") throw new NotFoundError("竞赛排名不可见");
  if (visibility === "participants" && !registered) {
    if (!viewerId) throw new UnauthorizedError("登录后才可查看竞赛排名");
    throw new ForbiddenError("仅参赛者可查看竞赛排名");
  }
}

/**
 * 返回带视图元数据的竞赛榜单。普通用户在封榜窗口及待结算期间只能读取
 * freeze_start_time 之前的稳定视图，正式快照发布后才切换为 official。
 */
export async function getContestRankingView(
  contestId: string,
  type: ContestType,
  isAdmin = false,
  viewerId?: string,
): Promise<ContestRankingResult> {
  const contest = await getContest(contestId, viewerId);
  if (contest.type !== type) {
    throw new BadRequestError("排名类型与竞赛赛制不一致");
  }
  const window = getContestFreezeWindow(contest);
  assertRankingVisibility(
    contest.ranking_visibility,
    isAdmin,
    viewerId,
    contest.is_registered === true,
  );

  if (isAdmin) {
    return {
      rows: await getKaggleRanking(contestId),
      view: "live",
      ranking_visibility: contest.ranking_visibility,
      freeze_start_time: window.start,
      freeze_end_time: window.end,
      settlement_pending: contest.status === "ended" &&
        !await getLatestContestRankingSnapshot(contestId),
    };
  }

  const snapshot = contest.status === "ended"
    ? await getLatestContestRankingSnapshot(contestId)
    : null;
  if (snapshot) {
    return {
      rows: snapshot.rows as KaggleRankingRow[],
      view: "official",
      ranking_visibility: contest.ranking_visibility,
      freeze_start_time: window.start,
      freeze_end_time: window.end,
      settlement_pending: false,
    };
  }

  const frozen = isContestFrozen(window) ||
    (contest.status === "ended" && window.start !== null);
  if (frozen) {
    return {
      rows: await getKaggleRanking(contestId, window.start!),
      view: "frozen",
      ranking_visibility: contest.ranking_visibility,
      freeze_start_time: window.start,
      freeze_end_time: window.end,
      settlement_pending: contest.status === "ended",
    };
  }

  if (contest.status === "ended") {
    // 没有配置封榜时也不能因“结束”自动暴露尚未结算的实时榜。
    throw new ConflictError("竞赛已结束，正式成绩尚未发布");
  }

  if (contest.status === "running" && !viewerId) {
    throw new UnauthorizedError("竞赛进行期间需登录查看排名");
  }
  if (contest.status === "running" && contest.is_registered !== true) {
    throw new ForbiddenError("仅参赛者可查看进行中的排名");
  }
  return {
    rows: await getKaggleRanking(contestId),
    view: "live",
    ranking_visibility: contest.ranking_visibility,
    freeze_start_time: window.start,
    freeze_end_time: window.end,
    settlement_pending: false,
  };
}

/**
 * 获取竞赛排名（类 Kaggle），保留旧数组返回接口供现有调用方使用。
 */
export async function getContestRanking(
  contestId: string,
  type: ContestType,
  isAdmin = false,
  viewerId?: string,
): Promise<KaggleRankingRow[]> {
  const result = await getContestRankingView(
    contestId,
    type,
    isAdmin,
    viewerId,
  );
  if (isAdmin || result.ranking_visibility === "public") {
    // 保留旧服务函数的进行中“仅返回本人”语义；REST 路由使用带元数据的
    // getContestRankingView，可按显式 public 策略返回公开榜。
    const contest = await getContest(contestId, viewerId);
    if (!isAdmin && contest.status === "running") {
      return result.rows.filter((row) => row.user_id === viewerId);
    }
    return result.rows;
  }
  return result.rows.filter((row) => row.user_id === viewerId);
}
