/**
 * 提交产物分层保留与受控物理清理（Artifact Tiered Retention）。
 *
 * 设计红线（对齐 `object-storage-governance.md`）：
 * 1. 默认关闭（opt-in：`ARTIFACT_RETENTION_ENABLED=false`），零隐式破坏；
 * 2. 只清理 `submissions.artifact_storage_url`，绝不触碰题目支持包、头像或未登记孤儿；
 * 3. 只清除 `submissions.artifact_storage_url = NULL`，完整保留提交记录、成绩与尝试历史；
 * 4. 物理删除一律走引用守卫 `deleteStorageObject()`：共享引用（如升级副本/内容去重）自动保留
 *    物理对象，确认零引用后物理删除并自动释放域存储配额（`releaseDomainStorageObject`）。
 */
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getLogger } from "@logtape/logtape";
import { getDb } from "../../../../shared/db/connection.ts";
import { contests, submissions } from "../../../../shared/db/schema.ts";
import type { ManagedTask } from "../../../../shared/runtime/managed-task.ts";
import { startPeriodicTask } from "../../../../shared/runtime/managed-task.ts";
import { deleteStorageObject } from "../../../assets/contracts/cross-module/services_registry.ts";

const logger = getLogger(["noj", "submission", "artifact-retention"]);

const DAY_MS = 86_400_000;
/** 后台分层回收轮询间隔：6 小时。 */
const ARTIFACT_RETENTION_INTERVAL_MS = 6 * 3_600_000;
/** 竞赛结束后的默认赛后宽限期（天），保障复核/重测/反作弊窗口不被清理。 */
export const DEFAULT_CONTEST_GRACE_DAYS = 7;

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
 * 有限批次扫描并按分层策略清理过期产物对象。
 *
 * `dryRun=true` 时仅执行只读判定与汇总统计，不修改数据库也不删除物理对象。
 */
export async function pruneExpiredSubmissionArtifacts(options?: {
  policy?: ArtifactRetentionPolicy;
  batchSize?: number;
  dryRun?: boolean;
  nowMs?: number;
}): Promise<ArtifactRetentionSweepResult> {
  const policy = options?.policy ?? resolveArtifactRetentionPolicyFromEnv();
  const batchSize = Math.max(1, Math.min(options?.batchSize ?? 50, 500));
  const dryRun = options?.dryRun ?? false;
  const nowMs = options?.nowMs ?? Date.now();

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

  if (!policy.enabled) return result;

  const db = getDb();
  const rows = await db
    .select({
      id: submissions.id,
      status: submissions.status,
      active_attempt_id: submissions.active_attempt_id,
      is_accepted: submissions.is_accepted,
      is_contest_accepted: submissions.is_contest_accepted,
      contest_effective_attempt_id: submissions.contest_effective_attempt_id,
      contest_id: submissions.contest_id,
      contest_end_time: contests.end_time,
      created_at: submissions.created_at,
      judge_finished_at: submissions.judge_finished_at,
      artifact_storage_url: submissions.artifact_storage_url,
    })
    .from(submissions)
    .leftJoin(contests, eq(submissions.contest_id, contests.id))
    .where(
      and(
        isNotNull(submissions.artifact_storage_url),
        isNull(submissions.active_attempt_id),
        inArray(submissions.status, ["finished", "error"]),
      ),
    )
    .orderBy(asc(submissions.created_at))
    .limit(batchSize);

  for (const row of rows) {
    result.scanned++;
    const decision = evaluateArtifactRetention(row, policy, nowMs);
    result.by_tier[decision.tier]++;
    if (!decision.eligible) {
      result.skipped_protected++;
      continue;
    }
    result.eligible++;
    if (dryRun) continue;

    try {
      // 事务内行锁复核并仅清空 artifact_storage_url，完整保留提交与成绩记录
      const detachedUrl = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select({
            id: submissions.id,
            status: submissions.status,
            active_attempt_id: submissions.active_attempt_id,
            artifact_storage_url: submissions.artifact_storage_url,
          })
          .from(submissions)
          .where(eq(submissions.id, row.id))
          .for("update")
          .limit(1);
        if (
          !locked ||
          !locked.artifact_storage_url ||
          locked.active_attempt_id !== null ||
          !["finished", "error"].includes(locked.status)
        ) {
          return null;
        }
        await tx
          .update(submissions)
          .set({ artifact_storage_url: null })
          .where(eq(submissions.id, row.id));
        return locked.artifact_storage_url;
      });

      if (!detachedUrl) {
        result.skipped_protected++;
        continue;
      }
      result.pruned++;

      // 事务提交后走引用守卫物理回收（有共享引用自动保留，否则删除并释放域配额）
      const delOutcome = await deleteStorageObject(detachedUrl);
      if (delOutcome.outcome === "deleted") {
        result.deleted_objects++;
      } else if (delOutcome.outcome === "referenced") {
        result.shared_retained++;
      } else {
        result.missing_objects++;
      }
    } catch (error) {
      result.failed++;
      logger.warn("产物分层清理单条失败，保留现状等待下次重试", {
        submission_id: row.id,
        error_type: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  return result;
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
