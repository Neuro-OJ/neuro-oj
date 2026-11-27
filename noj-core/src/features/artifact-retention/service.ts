/**
 * 提交产物分层保留与受控物理清理（Artifact Tiered Retention）。
 *
 * 设计红线（对齐 `object-storage-governance.md`）：
 * 1. 默认关闭（opt-in：`ARTIFACT_RETENTION_ENABLED=false`），零隐式破坏；
 * 2. 只清理 `submissions.artifact_storage_url`，绝不触碰题目支持包、头像或未登记孤儿；
 * 3. 只清除 `submissions.artifact_storage_url = NULL`，完整保留提交记录、成绩与尝试历史；
 * 4. 物理删除在同一数据库事务内经引用守卫 `deleteStorageObject(url, tx)` 完成：
 *    若存储短暂故障或存在在途上传预约，整个事务原子回滚（不丢失 `artifact_storage_url`），
 *    下轮扫描可幂等重试；确认零引用后物理删除并自动释放域存储配额。
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { getLogger } from "@logtape/logtape";
import { getDb } from "../../shared/db/connection.ts";
import { contests, submissions } from "../../shared/db/schema.ts";
import type { ManagedTask } from "../../shared/runtime/managed-task.ts";
import { startPeriodicTask } from "../../shared/runtime/managed-task.ts";
import { deleteStorageObject } from "../../modules/assets/contracts/cross-module/services_registry.ts";

const logger = getLogger(["noj", "feature", "artifact-retention"]);

const DAY_MS = 86_400_000;
/** 后台分层回收轮询间隔：6 小时。 */
const ARTIFACT_RETENTION_INTERVAL_MS = 6 * 3_600_000;
/** 竞赛结束后的默认赛后宽限期（天），保障复核/重测/反作弊窗口不被清理。 */
export const DEFAULT_CONTEST_GRACE_DAYS = 7;
/** 单次扫描最多向前翻页次数，防止大量受保护行无限扫表同时避免被前排受保护行饿死。 */
const DEFAULT_MAX_SCAN_PAGES = 10;

export type ArtifactRetentionTier =
  | "protected_inflight"
  | "protected_active_contest"
  | "best_or_accepted"
  | "non_best";

export interface ArtifactRetentionPolicy {
  /** 是否启用自动/受控清理（默认 false）。 */
  enabled: boolean;
  /** 非最佳、未通过产物的保留天数（默认 14；0 = 禁用此类清理）。 */
  nonBestRetentionDays: number;
  /** 通过/竞赛有效产物的保留天数（默认 0 = 永久保留；>0 则超期回收）。 */
  bestRetentionDays: number;
  /** 竞赛结束后的宽限期（天，默认 7）。 */
  contestGraceDays: number;
}

export const DEFAULT_ARTIFACT_RETENTION_POLICY: ArtifactRetentionPolicy = {
  enabled: false,
  nonBestRetentionDays: 14,
  bestRetentionDays: 0,
  contestGraceDays: DEFAULT_CONTEST_GRACE_DAYS,
};

export interface ArtifactRetentionCandidate {
  id: string;
  status: string;
  active_attempt_id: string | null;
  is_accepted: boolean;
  is_contest_accepted: boolean;
  contest_effective_attempt_id: string | null;
  contest_id: string | null;
  contest_end_time: string | null;
  created_at: string;
  judge_finished_at: string | null;
  artifact_storage_url: string | null;
}

export interface ArtifactRetentionDecision {
  eligible: boolean;
  tier: ArtifactRetentionTier;
  reason: string;
  expiresAt: string | null;
}

export interface ArtifactRetentionCursor {
  createdAt: string;
  id: string;
}

export type ArtifactPruneOutcome =
  | { outcome: "deleted" }
  | { outcome: "referenced" }
  | { outcome: "missing" }
  | { outcome: "skipped" };

export interface ArtifactRetentionSweepResult {
  dry_run: boolean;
  policy: ArtifactRetentionPolicy;
  scanned: number;
  eligible: number;
  pruned: number;
  deleted_objects: number;
  shared_retained: number;
  missing_objects: number;
  skipped_protected: number;
  failed: number;
  by_tier: Record<ArtifactRetentionTier, number>;
}

function parseEnvIntClamped(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseEnvBool(raw: string | undefined, fallback: boolean): boolean {
  if (!raw || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

/** 从 bootstrap 环境变量解析产物分层保留策略（零 DB 依赖，与注册表键严格对齐）。 */
export function resolveArtifactRetentionPolicyFromEnv(
  envGet: (key: string) => string | undefined = (key) => Deno.env.get(key),
): ArtifactRetentionPolicy {
  return {
    enabled: parseEnvBool(envGet("ARTIFACT_RETENTION_ENABLED"), false),
    nonBestRetentionDays: parseEnvIntClamped(
      envGet("ARTIFACT_NON_BEST_RETENTION_DAYS"),
      DEFAULT_ARTIFACT_RETENTION_POLICY.nonBestRetentionDays,
      0,
      3650,
    ),
    bestRetentionDays: parseEnvIntClamped(
      envGet("ARTIFACT_BEST_RETENTION_DAYS"),
      DEFAULT_ARTIFACT_RETENTION_POLICY.bestRetentionDays,
      0,
      3650,
    ),
    contestGraceDays: DEFAULT_CONTEST_GRACE_DAYS,
  };
}

function parseTimestampMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 纯函数判定单条提交产物是否满足分层回收条件。
 *
 * 优先级：
 * 1. Tier 0（在途评测 / 缺少 URL）：永久跳过；
 * 2. Tier 0（竞赛进行中或处于赛后宽限期）：严格保护；
 * 3. Tier 1（通过或竞赛有效成绩）：按 `bestRetentionDays`（默认 0 永久保留）；
 * 4. Tier 2（普通非最佳产物）：按 `nonBestRetentionDays`（默认 14 天）。
 */
export function evaluateArtifactRetention(
  candidate: ArtifactRetentionCandidate,
  policy: ArtifactRetentionPolicy,
  nowMs: number = Date.now(),
): ArtifactRetentionDecision {
  if (
    !candidate.artifact_storage_url ||
    candidate.active_attempt_id !== null ||
    candidate.status === "pending" ||
    candidate.status === "judging"
  ) {
    return {
      eligible: false,
      tier: "protected_inflight",
      reason: "提交正在评测或无产物对象",
      expiresAt: null,
    };
  }

  let contestGraceEndMs: number | null = null;
  if (candidate.contest_id !== null) {
    const contestEndMs = parseTimestampMs(candidate.contest_end_time);
    if (contestEndMs === null) {
      return {
        eligible: false,
        tier: "protected_active_contest",
        reason: "竞赛结束时间未知，保守跳过",
        expiresAt: null,
      };
    }
    contestGraceEndMs = contestEndMs +
      Math.max(0, policy.contestGraceDays) * DAY_MS;
    if (nowMs < contestGraceEndMs) {
      return {
        eligible: false,
        tier: "protected_active_contest",
        reason: "竞赛进行中或处于赛后宽限期",
        expiresAt: new Date(contestGraceEndMs).toISOString(),
      };
    }
  }

  const isBestOrAccepted = candidate.is_accepted ||
    candidate.is_contest_accepted ||
    candidate.contest_effective_attempt_id !== null;
  const tier: ArtifactRetentionTier = isBestOrAccepted
    ? "best_or_accepted"
    : "non_best";

  const retentionDays = isBestOrAccepted
    ? policy.bestRetentionDays
    : policy.nonBestRetentionDays;

  if (!policy.enabled) {
    return {
      eligible: false,
      tier,
      reason: "产物分层清理未启用（ARTIFACT_RETENTION_ENABLED=false）",
      expiresAt: null,
    };
  }

  if (retentionDays <= 0) {
    return {
      eligible: false,
      tier,
      reason: isBestOrAccepted
        ? "最佳/通过产物配置为永久保留"
        : "非最佳产物清理已禁用",
      expiresAt: null,
    };
  }

  const baseMs = parseTimestampMs(candidate.judge_finished_at) ??
    parseTimestampMs(candidate.created_at);
  if (baseMs === null) {
    return {
      eligible: false,
      tier,
      reason: "提交时间戳非法，保守跳过",
      expiresAt: null,
    };
  }

  const anchorMs = contestGraceEndMs !== null
    ? Math.max(baseMs, contestGraceEndMs)
    : baseMs;
  const expiresAtMs = anchorMs + retentionDays * DAY_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();

  if (nowMs < expiresAtMs) {
    return {
      eligible: false,
      tier,
      reason: "尚未达到保留期阈值",
      expiresAt,
    };
  }

  return {
    eligible: true,
    tier,
    reason: isBestOrAccepted
      ? `最佳/通过产物已超过 ${retentionDays} 天保留期`
      : `非最佳产物已超过 ${retentionDays} 天保留期`,
    expiresAt,
  };
}

/**
 * 通用分页扫描与受控回收调度器（支持零 DB 依赖单测）。
 *
 * 通过 keyset 游标 `(created_at, id)` 越过前排受保护记录，直到命中 `batchSize` 条
 * 可回收候选、扫描完表或达到 `maxPages` 上限；避免永久保留记录占据前 N 行导致饥饿。
 */
export async function runArtifactRetentionSweep(input: {
  policy: ArtifactRetentionPolicy;
  batchSize: number;
  dryRun: boolean;
  nowMs: number;
  maxPages?: number;
  fetchPage: (
    cursor: ArtifactRetentionCursor | null,
    limit: number,
  ) => Promise<ArtifactRetentionCandidate[]>;
  pruneCandidate: (
    candidate: ArtifactRetentionCandidate,
  ) => Promise<ArtifactPruneOutcome>;
}): Promise<ArtifactRetentionSweepResult> {
  const { policy, batchSize, dryRun, nowMs, fetchPage, pruneCandidate } = input;
  const maxPages = Math.max(1, input.maxPages ?? DEFAULT_MAX_SCAN_PAGES);

  const byTier: Record<ArtifactRetentionTier, number> = {
    protected_inflight: 0,
    protected_active_contest: 0,
    best_or_accepted: 0,
    non_best: 0,
  };

  const result: ArtifactRetentionSweepResult = {
    dry_run: dryRun,
    policy,
    scanned: 0,
    eligible: 0,
    pruned: 0,
    deleted_objects: 0,
    shared_retained: 0,
    missing_objects: 0,
    skipped_protected: 0,
    failed: 0,
    by_tier: byTier,
  };

  if (
    !policy.enabled ||
    (policy.nonBestRetentionDays <= 0 && policy.bestRetentionDays <= 0)
  ) {
    return result;
  }

  let cursor: ArtifactRetentionCursor | null = null;
  for (let page = 0; page < maxPages && result.eligible < batchSize; page++) {
    const rows = await fetchPage(cursor, batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = { createdAt: row.created_at, id: row.id };
      result.scanned++;
      const decision = evaluateArtifactRetention(row, policy, nowMs);
      result.by_tier[decision.tier]++;
      if (!decision.eligible) {
        result.skipped_protected++;
        continue;
      }

      if (dryRun) {
        result.eligible++;
        if (result.eligible >= batchSize) break;
        continue;
      }

      try {
        const outcome = await pruneCandidate(row);
        if (outcome.outcome === "skipped") {
          result.skipped_protected++;
          continue;
        }
        result.eligible++;
        result.pruned++;
        if (outcome.outcome === "deleted") {
          result.deleted_objects++;
        } else if (outcome.outcome === "referenced") {
          result.shared_retained++;
        } else {
          result.missing_objects++;
        }
      } catch (error) {
        result.eligible++;
        result.failed++;
        logger.warn("产物分层清理单条失败，已原子回滚等待下次重试", {
          submission_id: row.id,
          error_type: error instanceof Error ? error.name : typeof error,
        });
      }

      if (result.eligible >= batchSize) break;
    }

    if (rows.length < batchSize) break;
  }

  return result;
}

/**
 * 有限批次扫描并按分层策略清理过期产物对象。
 *
 * - 当 `bestRetentionDays <= 0` 时直接在 SQL 过滤掉永久保留的通过/竞赛有效记录；
 * - 结合 `(created_at, id)` 游标向后翻页，防止受保护记录永久阻塞后续过期清理；
 * - 逐条在 `FOR UPDATE` 行锁事务内重读策略相关字段并重算 `evaluateArtifactRetention`，
 *   防止并发重测刷新成绩或完成时间后被误删；
 * - 解绑 `artifact_storage_url = NULL` 与引用守卫 `deleteStorageObject(url, tx)` 放在
 *   同一事务内，存储故障或上传预约冲突时原子回滚，确保下次扫描可靠重试。
 */
export async function pruneExpiredSubmissionArtifacts(options?: {
  policy?: ArtifactRetentionPolicy;
  batchSize?: number;
  dryRun?: boolean;
  nowMs?: number;
  maxPages?: number;
}): Promise<ArtifactRetentionSweepResult> {
  const policy = options?.policy ?? resolveArtifactRetentionPolicyFromEnv();
  const batchSize = Math.max(1, Math.min(options?.batchSize ?? 50, 500));
  const dryRun = options?.dryRun ?? false;
  const nowMs = options?.nowMs ?? Date.now();

  const db = getDb();

  return await runArtifactRetentionSweep({
    policy,
    batchSize,
    dryRun,
    nowMs,
    maxPages: options?.maxPages,
    fetchPage: async (cursor, limit) => {
      const filters = [
        isNotNull(submissions.artifact_storage_url),
        isNull(submissions.active_attempt_id),
        inArray(submissions.status, ["finished", "error"]),
      ];
      // 永久保留最佳/通过产物时在 SQL 层直接排除，避免老记录长期占满扫描窗口
      if (policy.bestRetentionDays <= 0) {
        filters.push(
          eq(submissions.is_accepted, false),
          eq(submissions.is_contest_accepted, false),
          isNull(submissions.contest_effective_attempt_id),
        );
      }
      if (cursor !== null) {
        filters.push(
          or(
            gt(submissions.created_at, cursor.createdAt),
            and(
              eq(submissions.created_at, cursor.createdAt),
              gt(submissions.id, cursor.id),
            ),
          )!,
        );
      }
      return await db
        .select({
          id: submissions.id,
          status: submissions.status,
          active_attempt_id: submissions.active_attempt_id,
          is_accepted: submissions.is_accepted,
          is_contest_accepted: submissions.is_contest_accepted,
          contest_effective_attempt_id:
            submissions.contest_effective_attempt_id,
          contest_id: submissions.contest_id,
          contest_end_time: contests.end_time,
          created_at: submissions.created_at,
          judge_finished_at: submissions.judge_finished_at,
          artifact_storage_url: submissions.artifact_storage_url,
        })
        .from(submissions)
        .leftJoin(contests, eq(submissions.contest_id, contests.id))
        .where(and(...filters))
        .orderBy(asc(submissions.created_at), asc(submissions.id))
        .limit(limit);
    },
    pruneCandidate: async (row) => {
      return await db.transaction(async (tx): Promise<ArtifactPruneOutcome> => {
        // 锁顺序：先锁 submissions 行，再由 deleteStorageObjectTx 锁 storage_objects（与 job-attempt 一致）
        const [locked] = await tx
          .select({
            id: submissions.id,
            status: submissions.status,
            active_attempt_id: submissions.active_attempt_id,
            is_accepted: submissions.is_accepted,
            is_contest_accepted: submissions.is_contest_accepted,
            contest_effective_attempt_id:
              submissions.contest_effective_attempt_id,
            contest_id: submissions.contest_id,
            created_at: submissions.created_at,
            judge_finished_at: submissions.judge_finished_at,
            artifact_storage_url: submissions.artifact_storage_url,
          })
          .from(submissions)
          .where(eq(submissions.id, row.id))
          .for("update")
          .limit(1);
        if (!locked || !locked.artifact_storage_url) {
          return { outcome: "skipped" };
        }

        let contestEndTime: string | null = null;
        if (locked.contest_id !== null) {
          const [contestRow] = await tx
            .select({ end_time: contests.end_time })
            .from(contests)
            .where(eq(contests.id, locked.contest_id))
            .limit(1);
          contestEndTime = contestRow?.end_time ?? null;
        }

        // 持锁重评保留资格，防止并发重测刷新成绩或完成时间后按过期快照误删
        const freshDecision = evaluateArtifactRetention(
          { ...locked, contest_end_time: contestEndTime },
          policy,
          nowMs,
        );
        if (!freshDecision.eligible) {
          return { outcome: "skipped" };
        }

        const detachedUrl = locked.artifact_storage_url;
        await tx
          .update(submissions)
          .set({ artifact_storage_url: null })
          .where(eq(submissions.id, locked.id));

        // 同事务内执行引用守卫物理删除：若存储异常或存在在途预约则整笔回滚，保留 URL 下轮重试
        const delOutcome = await deleteStorageObject(detachedUrl, tx);
        if (delOutcome.outcome === "deleted") {
          return { outcome: "deleted" };
        }
        if (delOutcome.outcome === "referenced") {
          return { outcome: "referenced" };
        }
        return { outcome: "missing" };
      });
    },
  });
}

let retentionTask: ManagedTask | null = null;

/** 启动产物分层保留清理周期任务（默认关闭，仅 ARTIFACT_RETENTION_ENABLED=true 时激活）。 */
export function startArtifactRetentionTask(): ManagedTask {
  if (retentionTask) return retentionTask;
  const policy = resolveArtifactRetentionPolicyFromEnv();
  if (!policy.enabled) {
    return {
      name: "artifact-retention",
      stop: () => {},
      done: Promise.resolve(),
    };
  }
  const task = startPeriodicTask({
    name: "artifact-retention",
    intervalMs: ARTIFACT_RETENTION_INTERVAL_MS,
    runImmediately: false,
    run: async () => {
      const summary = await pruneExpiredSubmissionArtifacts({
        policy,
        batchSize: 50,
        dryRun: false,
      });
      if (summary.pruned > 0 || summary.failed > 0) {
        logger.info("提交产物分层保留清理批次完成", {
          scanned: summary.scanned,
          pruned: summary.pruned,
          deleted_objects: summary.deleted_objects,
          shared_retained: summary.shared_retained,
          failed: summary.failed,
        });
      }
    },
    onError: (error) => {
      logger.warn("提交产物分层保留清理批次失败，将重试", {
        error_type: error instanceof Error ? error.name : typeof error,
      });
    },
  });
  retentionTask = task;
  void task.done.then(() => {
    if (retentionTask === task) retentionTask = null;
  }).catch(() => {});
  return task;
}

/** 测试用：停止当前产物保留任务单例。 */
export function _resetArtifactRetentionForTest(): void {
  retentionTask?.stop();
}
