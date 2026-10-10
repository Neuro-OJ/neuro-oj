/**
 * Submissions 结果写回（PR-3 拆分）。
 *
 * 包含：
 * - saveEvaluationResult：由 mq/consumer 调用，写入 judge 返回的结果
 * - updateSubmissionStatus：状态机校验 + 时间戳更新
 *
 * 重测相关在 submissions-rejudge.ts；CRUD 在 submissions-crud.ts。
 */

import { eq } from "drizzle-orm";
import { sseEvents, submissions } from "./../../../../shared/db/schema.ts";
import {
  BadRequestError,
  NotFoundError,
} from "./../../../../shared/base/errors.ts";
import { getDb } from "./../../../../shared/db/connection.ts";
import { publishSearchIndexEvent } from "./../../../../shared/search-events.ts";
import { getStorageProvider } from "./../../../system/index.ts";
import type { JudgeResult, SubmissionStatus } from "../../types/index.ts";
import { applyNewResult, refreshRankingsView } from "../../../query/index.ts";
import { filterUnendedContestIds } from "../../../contest/index.ts";
import { getLogger } from "@logtape/logtape";
import { getRedis } from "./../../../../shared/mq/connection.ts";

const logger = getLogger(["noj", "submission"]);
import { Channels } from "./../../../../shared/sse/event-bus.ts";
import { sanitizeJudgeResult } from "./sanitize-judge-result.ts";
import {
  deriveResultKind,
  isAcceptedResult,
} from "../../../../shared/versioning/verdict.ts";
import { applyAttemptResult } from "../versioning/result-write.ts";

// 允许的状态转换
const VALID_TRANSITIONS: Record<SubmissionStatus, SubmissionStatus[]> = {
  pending: ["judging", "error"],
  judging: ["finished", "error"],
  finished: [],
  error: [],
};

/** 评测结果应用后需要实时通知的持久化 SSE 事件。 */
export interface SseEventOutboxItem {
  channel: string;
  payload: Record<string, unknown>;
  /** 事务内写入 `sse_events` 后返回的全局事件 id。 */
  event_id: number;
}

/** `saveEvaluationResult` 返回值。 */
export interface SaveEvaluationResultOutcome {
  applied: boolean;
  /** 已随业务事务持久化、待事务提交后发布 Redis 的事件。 */
  outbox_events: SseEventOutboxItem[];
  /** 首次结果对应的提交创建时间，用于端到端延迟观测。 */
  created_at?: string;
  /** 是否为重测结果；重测不参与首次 e2e 延迟统计。 */
  is_rejudge?: boolean;
  /** 版本化尝试链路结论：`graded` / `platform_error` / `ignored`；无尝试时为 null。 */
  attempt_applied?: string | null;
  /** 本次结果落到的评测尝试 ID（旧协议无尝试时为 null），供 token 吊销等使用。 */
  attempt_id?: string | null;
}

/**
 * 保存评测结果（幂等 + rejudge_seq 事务内校验）。
 *
 * 返回 `{ applied, outbox_events }`：`applied=false` 表示过时/重复消息已忽略；
 * `outbox_events` 是已随业务事务写入 `sse_events` 表、等待事务提交后
 * 发布 Redis 的事件列表（事务性 Outbox）。
 * 事务内对 submissions 行加锁，避免 NOJ-065 的 TOCTOU 与 NOJ-068/182
 * 的重复统计。
 */
export async function saveEvaluationResult(
  result: JudgeResult,
): Promise<SaveEvaluationResultOutcome> {
  const db = getDb();

  const incomingSeq = result.rejudge_seq ?? 0;
  const now = new Date().toISOString();

  const outcome = await db.transaction(async (tx) => {
    const [sub] = await tx
      .select({
        rejudge_seq: submissions.rejudge_seq,
        judge_run_id: submissions.judge_run_id,
        created_at: submissions.created_at,
        contest_id: submissions.contest_id,
        user_id: submissions.user_id,
        problem_id: submissions.problem_id,
        status: submissions.status,
        artifact_storage_url: submissions.artifact_storage_url,
        active_attempt_id: submissions.active_attempt_id,
      })
      .from(submissions)
      .where(eq(submissions.id, result.submission_id))
      .for("update")
      .limit(1);

    if (!sub) {
      logger.warn("提交不存在，忽略评测结果", {
        submission_id: result.submission_id,
      });
      return null;
    }

    // 过时结果：本次消息早于当前重测序号，直接丢弃。
    if (incomingSeq < sub.rejudge_seq) {
      logger.warn("忽略过时的评测结果", {
        submission_id: result.submission_id,
        result_seq: incomingSeq,
        current_seq: sub.rejudge_seq,
      });
      return null;
    }

    // 结果若**声明了** run_id（协议 v2 封套或 evaluator details.run_id），必须与
    // 当前在途尝试（`judge_run_id` = attempt id）一致，否则视为过时消息丢弃。
    // 未声明 run_id 的旧协议结果不在此处拦截，仍按 rejudge_seq / active_attempt_id
    // 归属（Handbook §5.5 的兼容路径）。
    const declaredRunId = (result.details as { run_id?: unknown } | undefined)
      ?.run_id ?? result.run_id ?? null;
    if (
      sub.judge_run_id && declaredRunId &&
      declaredRunId !== sub.judge_run_id
    ) {
      return null;
    }
    // 旧结果表 `evaluation_results` 已停止写入（Handbook §6.5）：评测事实的唯一来源是
    // `evaluation_attempts` 终态 + `submission_version_results` 当前判定 + 有效成绩投影。
    // 所有运行期读取均已迁离旧表，旧表只剩存量数据，等待整体删除迁移。

    // 状态机收紧：正常结果只允许 pending/judging → 终态。
    // error 提交重测时会先重置为 pending，因此也允许从 error 修复。
    const currentStatus = sub.status as SubmissionStatus;
    if (
      currentStatus !== "pending" && currentStatus !== "judging" &&
      currentStatus !== "error"
    ) {
      logger.warn("提交状态不允许写入评测结果", {
        submission_id: result.submission_id,
        status: currentStatus,
      });
      return null;
    }

    // 防御性归一（2026-09-12 评审 §4.3）：Redis 队列是 core↔judge 的信任边界，
    // judge 侧虽已 clamp，但 core 不能假设回传值一定合法——脏 score 会直接进入
    // 榜单/竞赛排名 SQL。归一结果与修正清单一起记录，便于发现 judge 异常。
    const { result: safeResult, adjustments } = sanitizeJudgeResult(result);
    if (adjustments.length > 0) {
      logger.warn("评测结果存在非法字段，已归一后落库", {
        submission_id: result.submission_id,
        adjustments,
      });
    }

    const submissionStatus: SubmissionStatus = [
        "error",
        "SystemError",
        "TimeLimitExceeded",
        "MemoryLimitExceeded",
        "RuntimeError",
      ].includes(safeResult.status)
      ? "error"
      : "finished";

    await tx
      .update(submissions)
      .set({
        status: submissionStatus,
        judge_finished_at: now,
      })
      .where(eq(submissions.id, safeResult.submission_id));

    // 版本化评测链路（Handbook §5.6）：尝试定位优先级
    // `attempt_id`（显式）→ `run_id`（协议 v2 回显，正式提交下同值）→
    // 提交的 `active_attempt_id`（旧协议兜底）。没有在途尝试（历史数据/直接插入的
    // 测试提交）则整段跳过，保持既有行为。
    const attemptId = result.attempt_id ?? result.run_id ??
      sub.active_attempt_id ?? null;
    let attemptApplied: string | null = null;
    if (attemptId) {
      const outcome = await applyAttemptResult({
        attemptId,
        resultKind: result.result_kind ?? deriveResultKind(safeResult.status),
        resultStatus: safeResult.status,
        score: safeResult.score,
        accepted: isAcceptedResult({
          status: safeResult.status,
          score: safeResult.score,
          details: safeResult.details,
        }),
        output: safeResult.output,
        details: safeResult.details,
        timeMs: safeResult.time_ms ?? null,
        memoryKb: safeResult.memory_kb ?? null,
      }, tx);
      attemptApplied = outcome.applied;
    }

    // 事务性 Outbox：在同一事务内写入 SSE 事件，提交后由调用方发布 Redis。
    const outboxEvents: SseEventOutboxItem[] = [];
    const [submissionEventRow] = await tx.insert(sseEvents).values({
      channel: Channels.submission(result.submission_id),
      payload: { type: "submission:updated", id: result.submission_id },
      created_at: now,
    }).returning({ id: sseEvents.id });
    outboxEvents.push({
      channel: Channels.submission(result.submission_id),
      payload: { type: "submission:updated", id: result.submission_id },
      event_id: submissionEventRow.id,
    });

    if (sub.contest_id) {
      const [contestEventRow] = await tx.insert(sseEvents).values({
        channel: Channels.contestRanking(sub.contest_id),
        payload: {
          type: "contest:ranking:updated",
          contest_id: sub.contest_id,
          submission_id: result.submission_id,
        },
        created_at: now,
      }).returning({ id: sseEvents.id });
      outboxEvents.push({
        channel: Channels.contestRanking(sub.contest_id),
        payload: {
          type: "contest:ranking:updated",
          contest_id: sub.contest_id,
          submission_id: result.submission_id,
        },
        event_id: contestEventRow.id,
      });
    }

    return {
      applied: true,
      attempt_applied: attemptApplied,
      attempt_id: attemptId,
      created_at: sub.created_at,
      contest_id: sub.contest_id,
      user_id: sub.user_id,
      problem_id: sub.problem_id,
      is_rejudge: sub.rejudge_seq > 0,
      artifact_storage_url: sub.artifact_storage_url,
      outbox_events: outboxEvents,
    };
  });

  if (!outcome) return { applied: false, outbox_events: [] };

  // artifact 评测完成（finished/error）后立即删除存储对象
  if (outcome.artifact_storage_url) {
    try {
      const storage = await getStorageProvider();
      await storage.delete(outcome.artifact_storage_url);
      logger.info("artifact 评测完成，已删除存储对象", {
        submission_id: result.submission_id,
      });
    } catch (err) {
      logger.error("artifact 评测后删除失败", {
        submission_id: result.submission_id,
        storage_url: outcome.artifact_storage_url,
        err,
      });
    }
  }

  // 统计缓存仅对首次结果递增；重测结果不计入（NOJ-068）。
  // 赛中数据隔离（DL-03）：未结束竞赛的提交不计入全站实时统计，也不广播 stats:updated，防止成为满分判分预言机。
  if (!outcome.is_rejudge && outcome.created_at) {
    if (outcome.contest_id) {
      const unended = await filterUnendedContestIds([outcome.contest_id]);
      if (!unended.has(outcome.contest_id)) {
        applyNewResult();
      }
    } else {
      applyNewResult();
    }
  }

  // PR-4 评审修订：异步触发榜单物化视图刷新
  // 不 await：避免阻塞主业务（saveEvaluationResult 是热路径）
  // 失败仅 console.error（rankings.ts 内已处理）
  refreshRankingsView().catch(() => {/* ignore - rankings.ts 内已记录 */});

  // 决策 7 · AR-08：评测完成立即在 Redis 原子吊销本次 eval_token。
  //
  // 版本化后按**尝试**吊销（Handbook §6.7）：`llm:attempt:revoked:<attempt_id>`
  // 只终结这一次执行；同一提交重测签发的新 token 走新键，不会被旧吊销误杀。
  // 提交维度的旧键继续写，用于吊销旧协议（无 attempt_id）token。
  try {
    const redis = getRedis();
    if (redis.status === "ready") {
      if (outcome.attempt_id) {
        void redis.set(
          `llm:attempt:revoked:${outcome.attempt_id}`,
          "1",
          "EX",
          3600,
        );
      }
      void redis.set(
        `llm:token:revoked:${result.submission_id}`,
        "1",
        "EX",
        3600,
      );
    }
  } catch {
    // ignore
  }

  // 注：此前此处会在选手首次通过题目时写入社区自动动态（`first_accepted`，metadata
  // 含内部 submission_id）。该功能已按审计 VULN-08 整体下线：事件不携带竞赛上下文，
  // 使全站用户（含场外人员）在**封榜期**刷新社区动态流即可看到"某选手首次通过题目
  // X"，封榜因此完全失去意义；metadata 还直接暴露内部凭证 submission_id。
  // 需要"首次通过"事实时请直接查 submissions / evaluation_results，不要广播。

  return {
    applied: true,
    outbox_events: outcome.outbox_events,
    created_at: outcome.created_at,
    is_rejudge: outcome.is_rejudge,
    attempt_applied: outcome.attempt_applied ?? null,
    attempt_id: outcome.attempt_id ?? null,
  };
}

/**
 * 更新提交状态。
 * 校验状态转换是否合法（pending → judging → finished）。
 * 同步更新 judge_started_at / judge_finished_at 时间戳。
 *
 * @throws {NotFoundError} 提交不存在
 * @throws {BadRequestError} 状态转换非法
 */
export async function updateSubmissionStatus(
  id: string,
  status: SubmissionStatus,
): Promise<void> {
  const db = getDb();

  const existing = await db
    .select({ status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("提交不存在");
  }

  const current = existing[0].status as SubmissionStatus;
  if (!VALID_TRANSITIONS[current]?.includes(status)) {
    throw new BadRequestError(`无效的状态转换: ${current} → ${status}`);
  }

  const now = new Date().toISOString();
  const updates: Record<string, string | undefined> = { status };

  // 设置 judge_started_at：pending → judging
  if (status === "judging") {
    updates.judge_started_at = now;
  }

  // 设置 judge_finished_at：judging → finished / error
  if (status === "finished" || status === "error") {
    updates.judge_finished_at = now;
  }

  await db
    .update(submissions)
    .set(updates)
    .where(eq(submissions.id, id));
  await publishSearchIndexEvent("submission", id, "upsert");
}
