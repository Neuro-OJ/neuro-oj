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
import { evaluationAttempts } from "../../../../shared/db/schema.ts";
import { lockProjectionHosts } from "../versioning/projection.ts";
import { sseEvents, submissions } from "./../../../../shared/db/schema.ts";
import {
  BadRequestError,
  NotFoundError,
} from "./../../../../shared/base/errors.ts";
import { getDb } from "./../../../../shared/db/connection.ts";
import { publishSearchIndexEvent } from "./../../../../shared/search-events.ts";
import type { JudgeResult, SubmissionStatus } from "../../types/index.ts";
import { applyNewResult, refreshRankingsView } from "../../../query/index.ts";
import { filterUnendedContestIds } from "../../../contest/index.ts";
import { getLogger } from "@logtape/logtape";
const logger = getLogger(["noj", "submission"]);
import { Channels } from "./../../../../shared/sse/event-bus.ts";
import {
  isValidGradedScore,
  sanitizeJudgeResult,
} from "./sanitize-judge-result.ts";
import { isAcceptedResult } from "../../../../shared/versioning/verdict.ts";
import type { AttemptResultKind } from "../../../../shared/versioning/types.ts";
import { applyAttemptResult } from "../versioning/result-write.ts";
import { runAttemptTerminalRevocationAfterCommit } from "../versioning/attempts.ts";

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

  if (
    result.evaluation_protocol_version !== 2 || !result.run_id ||
    !result.problem_version_id ||
    (result.result_kind !== "graded" &&
      result.result_kind !== "platform_error") ||
    result.attempt_id !== result.run_id ||
    !Number.isInteger(result.rejudge_seq) || result.rejudge_seq! < 0
  ) {
    return { applied: false, outbox_events: [] };
  }
  const incomingSeq = result.rejudge_seq!;
  const now = new Date().toISOString();

  const outcome = await db.transaction(async (tx) => {
    const [identity] = await tx.select({
      problem_id: submissions.problem_id,
      contest_id: submissions.contest_id,
    }).from(submissions).where(eq(submissions.id, result.submission_id));
    if (!identity) return null;
    await lockProjectionHosts(tx, {
      kind: "submission",
      id: result.submission_id,
      ...identity,
    });
    const [sub] = await tx
      .select({
        rejudge_seq: submissions.rejudge_seq,
        judge_run_id: submissions.judge_run_id,
        created_at: submissions.created_at,
        contest_id: submissions.contest_id,
        user_id: submissions.user_id,
        problem_id: submissions.problem_id,
        domain_id: submissions.domain_id,
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

    const [attempt] = await tx.select().from(evaluationAttempts).where(
      eq(evaluationAttempts.id, result.run_id!),
    );
    // 封套绑定必须同时校验来源、题目、版本与序列；不从 evaluator 可控 details 取 run_id。
    if (
      !attempt || attempt.submission_id !== result.submission_id ||
      attempt.problem_id !== sub.problem_id ||
      attempt.problem_version_id !== result.problem_version_id ||
      attempt.sequence !== incomingSeq || sub.rejudge_seq !== incomingSeq ||
      sub.active_attempt_id !== attempt.id || sub.judge_run_id !== attempt.id
    ) {
      logger.warn("忽略过时的评测结果或不匹配封套", {
        submission_id: result.submission_id,
        run_id: result.run_id,
        incoming_seq: incomingSeq,
      });
      return null;
    }

    // 防御性归一（2026-09-12 评审 §4.3）：Redis 队列是 core↔judge 的信任边界，
    // judge 侧虽已 clamp，但 core 不能假设回传值一定合法——脏 score 会直接进入
    // 榜单/竞赛排名 SQL。归一结果与修正清单一起记录，便于发现 judge 异常。
    //
    // tracking #29（core 侧防御）：非法评分（缺字段、字符串、非整数、越界）**不得**
    // 被静默写成正式 0/满分——那会用一条假判定替换已有正式成绩。判定为平台错误：
    // 只写尝试终态与运行状态，`submission_version_results` 与有效字段保持原样。
    const declaredKind = result.result_kind!;
    const scoreInvalid = declaredKind === "graded" &&
      !isValidGradedScore(result.score);
    const resultKind: AttemptResultKind = scoreInvalid
      ? "platform_error"
      : declaredKind;
    if (scoreInvalid) {
      logger.error("评测结果评分非法，按平台错误处理（保留已有正式判定）", {
        submission_id: result.submission_id,
        attempt_id: result.attempt_id,
        score_type: typeof result.score,
      });
    }

    const { result: safeResult, adjustments } = sanitizeJudgeResult(result);
    if (adjustments.length > 0) {
      logger.warn("评测结果存在非法字段，已归一后落库", {
        submission_id: result.submission_id,
        adjustments,
      });
    }

    const attemptId = attempt.id;
    const appliedAttempt = await applyAttemptResult({
      attemptId,
      resultKind,
      resultStatus: scoreInvalid ? "INVALID_SCORE" : safeResult.status,
      score: resultKind === "platform_error" ? null : safeResult.score,
      accepted: resultKind === "graded" && isAcceptedResult({
        status: safeResult.status,
        score: safeResult.score,
        details: safeResult.details,
      }),
      output: safeResult.output,
      details: safeResult.details,
      timeMs: safeResult.time_ms ?? null,
      memoryKb: safeResult.memory_kb ?? null,
    }, tx);
    if (appliedAttempt.applied === "ignored") return null;
    const attemptApplied = appliedAttempt.applied;

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
      // 冻结快照：终态后处理据此推导已签发 token 的 TTL 上界（§6.7）
      task_snapshot: attempt.task_snapshot,
      created_at: sub.created_at,
      contest_id: sub.contest_id,
      user_id: sub.user_id,
      problem_id: sub.problem_id,
      domain_id: sub.domain_id,
      is_rejudge: attempt.source !== "initial",
      artifact_storage_url: sub.artifact_storage_url,
      outbox_events: outboxEvents,
    };
  });

  if (!outcome) return { applied: false, outbox_events: [] };

  // 统计缓存仅对首次结果递增；重测结果不计入（NOJ-068）。
  // 赛中数据隔离（DL-03）：未结束竞赛的提交不计入全站实时统计，也不广播 stats:updated，防止成为满分判分预言机。
  if (!outcome.is_rejudge && outcome.created_at) {
    if (outcome.contest_id) {
      const unended = await filterUnendedContestIds([outcome.contest_id]);
      if (!unended.has(outcome.contest_id)) {
        applyNewResult(outcome.domain_id ?? undefined);
      }
    } else {
      applyNewResult(outcome.domain_id ?? undefined);
    }
  }

  // 刷新属于本次结果处理的在途工作，消费者必须等待它结束后才能完成关闭排空。
  // 正式结果已经提交；刷新失败由 rankings.ts 记录并使用内联查询，不回滚正式成绩。
  await refreshRankingsView();

  // 决策 7 · AR-08：评测完成立即在 Redis 原子吊销本次 eval_token。
  //
  // 版本化后按**尝试**吊销（Handbook §6.7）：`llm:attempt:revoked:<attempt_id>`
  // 只终结这一次执行；同一提交重测签发的新 token 走新键，不会被旧吊销误杀。
  // 走**统一的尝试终态后处理**（`revokeAttemptLlmTokens`）：worker/sweeper 的永久
  // 失败、重试耗尽与溃复失败路径共用同一入口，标记 TTL 按尝试快照推导，
  // 覆盖该尝试全部已签发 token 的剩余有效期（不再写死 3600s）。
  if (outcome.attempt_id) {
    // 提交后立即尝试；失败保留 outbox pending，由后台消费者重试直到 done
    await runAttemptTerminalRevocationAfterCommit(outcome.attempt_id);
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
