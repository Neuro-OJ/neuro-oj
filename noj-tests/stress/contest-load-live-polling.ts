/**
 * 模拟赛压测真实测试环境（--live）异步轮询与排队耗时计算模块。
 *
 * 从 `contest-load-live.ts` 拆出以保持单文件精简并集中处理：
 * - 服务端 ISO 时间戳解析与提交/重测排队耗时计算；
 * - 提交终态轮询（`GET /domains/:slug/submissions/:id`）；
 * - 重测批任务及其关联 judging attempt 的轮询（通过 `/submission-jobs/:id/items`
 *   与 `/submissions/:id` 追踪真实评测开始时间，而非把 `running` 派发态当作开始评测）；
 * - low 档预热 seed 提交创建与等待。
 */

import {
  type PriorityTier,
  round2,
  type SubmissionRecord,
  type WorkloadItem,
} from "./contest-load-types.ts";
import { type SemaphoreRunner } from "./contest-load-auth.ts";

export interface LiveContext {
  baseUrl: string;
  domainSlug: string;
  controlHeaders: Record<string, string>;
  userHeadersList: Record<string, string>[];
  userHeadersByUserId: Map<string, Record<string, string>>;
  fetchImpl: typeof fetch;
  startedAt: number;
  pollIntervalMs: number;
  timeoutMs: number;
  contestId?: string;
  contestIsRunning: boolean;
  aiProblemRef?: string;
  oiProblemRef?: string;
  aiVersionId?: string;
  oiVersionId?: string;
  aiContestVersionId?: string;
  oiContestVersionId?: string;
  aiContestLabel: string;
  oiContestLabel: string;
  rejudgePool: string[];
  rejudgeCursor: number;
  runNonce: string;
}

export interface PendingPollJob {
  kind: "submission" | "rejudge";
  item: WorkloadItem;
  actualPriority: PriorityTier;
  targetId: string;
  sourceSubmissionId?: string;
  headers: Record<string, string>;
  reqStart: number;
  reqStartEpochMs: number;
  createdAtEpochMs?: number;
  sentAtMs: number;
  acceptedAtMs: number;
  submitHttpMs: number;
  httpStatus: number;
}

interface SubmissionAttemptSnapshot {
  attempt_id?: string;
  state?: string;
  source?: string;
  created_at?: string | null;
  started_at?: string | null;
  judge_started_at?: string | null;
}

interface SubmissionDetailSnapshot {
  status?: string;
  created_at?: string | null;
  judge_started_at?: string | null;
  latest_attempt_id?: string | null;
  latest_attempt?: SubmissionAttemptSnapshot | null;
  attempts?: SubmissionAttemptSnapshot[];
}

interface RejudgeJobItemSnapshot {
  id?: string;
  source_id?: string;
  status?: string;
  attempt_id?: string | null;
  result_submission_id?: string | null;
}

/** 超过剩余超时预算时抛出的内部超时错误。 */
export class DeadlineTimeoutError extends Error {
  constructor(message = "请求超出剩余超时预算") {
    super(message);
    this.name = "DeadlineTimeoutError";
  }
}

/** 在剩余超时预算内执行异步操作；超时时中止 AbortSignal 并立即拒绝。 */
export async function runWithDeadline<T>(
  remainingMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (remainingMs <= 0) {
    throw new DeadlineTimeoutError();
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new DeadlineTimeoutError();
      controller.abort(err);
      reject(err);
    }, remainingMs);
  });
  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fetchJsonWithDeadline<T>(
  deadline: number,
  withPollSlot: SemaphoreRunner,
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: true; data: T } | { ok: false }> {
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) return { ok: false };
  try {
    return await runWithDeadline(remainingMs, async (signal) => {
      const res = await withPollSlot(
        () => fetchImpl(url, { headers, signal }),
        { signal },
      );
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ok: false as const };
      }
      const data = await res.json() as T;
      return { ok: true as const, data };
    });
  } catch {
    return { ok: false };
  }
}

/** 解析服务端 ISO 时间戳为 epoch 毫秒；缺失或非法返回 null。 */
export function parseIsoTimestampMs(
  value: string | null | undefined,
): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 计算提交/重测的队列等待耗时（ms）：
 * - 优先使用服务端 `judge_started_at` 与服务端 `created_at` 计算（同源时钟，无时钟偏移），钳位到 `>= 0`；
 * - 若服务端未返回 `created_at`，回退以客户端 `reqStartEpochMs` 为基准，并钳位到 `[0, e2eMs]`；
 * - 若 `judge_started_at` 仍为 null/缺失，依次回退到首次观察到 `judging` 的相对时间或 `max(0, e2eMs - submitHttpMs)`。
 */
export function resolveSubmissionQueueWaitMs(params: {
  judgeStartedAt: string | null | undefined;
  serverCreatedAt?: string | null;
  jobCreatedAtEpochMs?: number;
  reqStartEpochMs: number;
  observedStartedAtMs: number | null;
  e2eMs: number;
  submitHttpMs: number;
}): number {
  const startedEpochMs = parseIsoTimestampMs(params.judgeStartedAt);
  if (startedEpochMs !== null) {
    const serverCreatedMs = parseIsoTimestampMs(params.serverCreatedAt) ??
      params.jobCreatedAtEpochMs ?? null;
    if (serverCreatedMs !== null) {
      return Math.max(0, startedEpochMs - serverCreatedMs);
    }
    return Math.max(
      0,
      Math.min(params.e2eMs, startedEpochMs - params.reqStartEpochMs),
    );
  }
  return params.observedStartedAtMs ??
    Math.max(0, params.e2eMs - params.submitHttpMs);
}

interface RejudgeAttemptProgress {
  trackedSubmissionId: string | null;
  trackedAttemptId: string | null;
  rejudgeJobCreatedAt: string | null;
  directJobStartedAt: string | null;
  attemptCreatedAt: string | null;
  attemptStartedAt: string | null;
  observedAttemptJudgingAtMs: number | null;
}

function selectRejudgeAttempt(
  detail: SubmissionDetailSnapshot,
  trackedAttemptId: string | null,
  rejudgeFloorEpochMs: number,
): SubmissionAttemptSnapshot | undefined {
  const candidates: SubmissionAttemptSnapshot[] = [
    ...(Array.isArray(detail.attempts) ? detail.attempts : []),
    ...(detail.latest_attempt ? [detail.latest_attempt] : []),
  ];
  if (trackedAttemptId !== null) {
    return candidates.find((a) => a.attempt_id === trackedAttemptId);
  }
  return candidates.find((a) => {
    if (a.source !== "rejudge") return false;
    const createdMs = parseIsoTimestampMs(a.created_at);
    return createdMs === null || createdMs >= rejudgeFloorEpochMs;
  });
}

async function inspectRejudgeAttemptStart(
  job: PendingPollJob,
  ctx: LiveContext,
  withPollSlot: SemaphoreRunner,
  deadline: number,
  state: RejudgeAttemptProgress,
): Promise<void> {
  if (state.directJobStartedAt !== null || state.attemptStartedAt !== null) {
    return;
  }

  if (state.trackedAttemptId === null) {
    const itemsUrl = `${ctx.baseUrl}/api/v1/domains/${
      encodeURIComponent(ctx.domainSlug)
    }/submission-jobs/${encodeURIComponent(job.targetId)}/items`;
    const itemsResp = await fetchJsonWithDeadline<{
      data?: RejudgeJobItemSnapshot[];
    }>(deadline, withPollSlot, ctx.fetchImpl, itemsUrl, job.headers);
    if (itemsResp.ok) {
      const items = Array.isArray(itemsResp.data.data)
        ? itemsResp.data.data
        : [];
      const matchedItem = items.find((it) =>
        it.source_id === job.sourceSubmissionId
      ) ?? items[0];
      if (matchedItem) {
        state.trackedAttemptId = matchedItem.attempt_id ??
          state.trackedAttemptId;
        state.trackedSubmissionId = matchedItem.result_submission_id ??
          matchedItem.source_id ??
          state.trackedSubmissionId;
      }
    }
  }

  if (state.trackedSubmissionId === null) return;

  const subUrl = `${ctx.baseUrl}/api/v1/domains/${
    encodeURIComponent(ctx.domainSlug)
  }/submissions/${encodeURIComponent(state.trackedSubmissionId)}`;
  const subResp = await fetchJsonWithDeadline<
    SubmissionDetailSnapshot & { data?: SubmissionDetailSnapshot }
  >(deadline, withPollSlot, ctx.fetchImpl, subUrl, job.headers);
  if (!subResp.ok) return;

  const rawDetail = subResp.data;
  const detail = rawDetail.data ?? rawDetail;
  const baseFloorMs = parseIsoTimestampMs(state.attemptCreatedAt) ??
    parseIsoTimestampMs(state.rejudgeJobCreatedAt) ??
    job.reqStartEpochMs;
  const attempt = selectRejudgeAttempt(
    detail,
    state.trackedAttemptId,
    baseFloorMs,
  );
  if (attempt) {
    state.attemptCreatedAt ??= attempt.created_at ?? null;
    const attemptStart = attempt.started_at ?? attempt.judge_started_at ?? null;
    if (parseIsoTimestampMs(attemptStart) !== null) {
      state.attemptStartedAt = attemptStart;
      return;
    }
    if (
      attempt.state === "judging" && state.observedAttemptJudgingAtMs === null
    ) {
      state.observedAttemptJudgingAtMs = performance.now() - job.reqStart;
    }
  } else if (
    state.trackedAttemptId === null &&
    detail.status === "judging" &&
    state.observedAttemptJudgingAtMs === null
  ) {
    state.observedAttemptJudgingAtMs = performance.now() - job.reqStart;
  }

  const effectiveFloorMs = parseIsoTimestampMs(state.attemptCreatedAt) ??
    parseIsoTimestampMs(state.rejudgeJobCreatedAt) ??
    job.reqStartEpochMs;
  const judgeStartedMs = parseIsoTimestampMs(detail.judge_started_at);
  const attemptPending = attempt !== undefined && attempt.state === "queued";
  if (
    !attemptPending &&
    judgeStartedMs !== null &&
    judgeStartedMs >= effectiveFloorMs
  ) {
    state.attemptStartedAt = detail.judge_started_at ?? null;
  }
}

/** 异步轮询阶段：独立跟踪单个已受理 submission / job 至终态或超时。 */
export async function pollAcceptedJob(
  job: PendingPollJob,
  ctx: LiveContext,
  withPollSlot: SemaphoreRunner,
): Promise<SubmissionRecord> {
  const deadline = job.reqStart + ctx.timeoutMs;
  let startedAtMs: number | null = null;
  const rejudgeState: RejudgeAttemptProgress = {
    trackedSubmissionId: job.sourceSubmissionId ?? null,
    trackedAttemptId: null,
    rejudgeJobCreatedAt: null,
    directJobStartedAt: null,
    attemptCreatedAt: null,
    attemptStartedAt: null,
    observedAttemptJudgingAtMs: null,
  };
  const pollUrl = job.kind === "submission"
    ? `${ctx.baseUrl}/api/v1/domains/${
      encodeURIComponent(ctx.domainSlug)
    }/submissions/${encodeURIComponent(job.targetId)}`
    : `${ctx.baseUrl}/api/v1/domains/${
      encodeURIComponent(ctx.domainSlug)
    }/submission-jobs/${encodeURIComponent(job.targetId)}`;

  while (performance.now() < deadline) {
    if (job.kind === "submission") {
      const pollResp = await fetchJsonWithDeadline<{
        status?: string;
        created_at?: string | null;
        judge_started_at?: string | null;
        data?: {
          status?: string;
          created_at?: string | null;
          judge_started_at?: string | null;
        };
      }>(deadline, withPollSlot, ctx.fetchImpl, pollUrl, job.headers);
      if (pollResp.ok) {
        const raw = pollResp.data;
        const detail = raw.data ?? raw;
        if (startedAtMs === null && detail.status === "judging") {
          startedAtMs = performance.now() - job.reqStart;
        }
        if (detail.status === "finished" || detail.status === "error") {
          if (detail.status === "finished") {
            ctx.rejudgePool.push(job.targetId);
          }
          const e2eMs = performance.now() - job.reqStart;
          const queueWaitMs = resolveSubmissionQueueWaitMs({
            judgeStartedAt: detail.judge_started_at,
            serverCreatedAt: detail.created_at,
            jobCreatedAtEpochMs: job.createdAtEpochMs,
            reqStartEpochMs: job.reqStartEpochMs,
            observedStartedAtMs: startedAtMs,
            e2eMs,
            submitHttpMs: job.submitHttpMs,
          });
          return {
            index: job.item.index,
            userId: job.item.userId,
            problemKind: job.item.problemKind,
            priority: job.actualPriority,
            sentAtMs: round2(job.sentAtMs),
            acceptedAtMs: round2(job.acceptedAtMs),
            submitHttpMs: round2(job.submitHttpMs),
            queueWaitMs: round2(queueWaitMs),
            e2eLatencyMs: round2(e2eMs),
            completedAtMs: round2(performance.now() - ctx.startedAt),
            httpStatus: job.httpStatus,
            outcome: detail.status === "finished" ? "ok" : "error",
          };
        }
      }
    } else {
      const pollResp = await fetchJsonWithDeadline<{
        status?: string;
        created_at?: string | null;
        judge_started_at?: string | null;
        started_at?: string | null;
        counts?: Record<string, number>;
        data?: {
          status?: string;
          created_at?: string | null;
          judge_started_at?: string | null;
          started_at?: string | null;
          counts?: Record<string, number>;
        };
      }>(deadline, withPollSlot, ctx.fetchImpl, pollUrl, job.headers);
      if (pollResp.ok) {
        const raw = pollResp.data;
        const rejudgeJob = raw.data ?? raw;
        if (parseIsoTimestampMs(rejudgeJob.created_at) !== null) {
          rejudgeState.rejudgeJobCreatedAt ??= rejudgeJob.created_at ?? null;
        }
        const directStart = rejudgeJob.judge_started_at ??
          rejudgeJob.started_at ?? null;
        if (parseIsoTimestampMs(directStart) !== null) {
          rejudgeState.directJobStartedAt ??= directStart;
        }

        // 不将批任务 status === "running"（仅代表条目已入 Redis 队列）视为开始评测；
        // 通过作业条目与提交详情追踪关联 judging attempt 的真实开始时间。
        await inspectRejudgeAttemptStart(
          job,
          ctx,
          withPollSlot,
          deadline,
          rejudgeState,
        );

        if (
          rejudgeJob.status === "completed" ||
          rejudgeJob.status === "completed_with_errors" ||
          rejudgeJob.status === "cancelled" ||
          rejudgeJob.status === "failed"
        ) {
          const e2eMs = performance.now() - job.reqStart;
          const counts = rejudgeJob.counts ?? {};
          const hasFailures = (counts.failed ?? 0) > 0 ||
            (counts.skipped ?? 0) > 0 ||
            rejudgeJob.status !== "completed";
          const queueWaitMs = resolveSubmissionQueueWaitMs({
            judgeStartedAt: rejudgeState.attemptStartedAt ??
              rejudgeState.directJobStartedAt,
            serverCreatedAt: rejudgeState.rejudgeJobCreatedAt ??
              rejudgeState.attemptCreatedAt,
            reqStartEpochMs: job.reqStartEpochMs,
            observedStartedAtMs: rejudgeState.observedAttemptJudgingAtMs,
            e2eMs,
            submitHttpMs: job.submitHttpMs,
          });
          return {
            index: job.item.index,
            userId: job.item.userId,
            problemKind: job.item.problemKind,
            priority: "low",
            sentAtMs: round2(job.sentAtMs),
            acceptedAtMs: round2(job.acceptedAtMs),
            submitHttpMs: round2(job.submitHttpMs),
            queueWaitMs: round2(queueWaitMs),
            e2eLatencyMs: round2(e2eMs),
            completedAtMs: round2(performance.now() - ctx.startedAt),
            httpStatus: job.httpStatus,
            outcome: hasFailures ? "error" : "ok",
            error: hasFailures
              ? `重测任务未完整成功: status=${rejudgeJob.status}, counts=${
                JSON.stringify(counts)
              }`
              : undefined,
          };
        }
      }
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await new Promise((r) =>
      setTimeout(r, Math.min(ctx.pollIntervalMs, remaining))
    );
  }

  return {
    index: job.item.index,
    userId: job.item.userId,
    problemKind: job.item.problemKind,
    priority: job.actualPriority,
    sentAtMs: round2(job.sentAtMs),
    acceptedAtMs: round2(job.acceptedAtMs),
    submitHttpMs: round2(job.submitHttpMs),
    queueWaitMs: round2(ctx.timeoutMs),
    e2eLatencyMs: round2(ctx.timeoutMs),
    completedAtMs: round2(performance.now() - ctx.startedAt),
    httpStatus: job.httpStatus,
    outcome: "timeout",
    error: job.kind === "rejudge"
      ? "轮询 low 优先级重测任务超时"
      : "轮询评测结果超时",
  };
}

/** 计时窗口开始前发送并等待一批预热 seed 普通提交完成，为混合优先级压测中的 low 档提供真实可重测目标。 */
export async function seedRejudgeTargets(opts: {
  count: number;
  fetchImpl: typeof fetch;
  baseUrl: string;
  domainSlug: string;
  userHeadersList: Record<string, string>[];
  aiProblemRef?: string;
  oiProblemRef?: string;
  aiVersionId?: string;
  oiVersionId?: string;
  pollIntervalMs: number;
  timeoutMs: number;
  withPollSlot: SemaphoreRunner;
  runNonce: string;
}): Promise<string[]> {
  if (opts.count <= 0) return [];
  const targets: Array<{
    kind: "ai" | "oi";
    problemRef: string;
    versionId: string;
  }> = [];
  if (opts.oiProblemRef && opts.oiVersionId) {
    targets.push({
      kind: "oi",
      problemRef: opts.oiProblemRef,
      versionId: opts.oiVersionId,
    });
  }
  if (opts.aiProblemRef && opts.aiVersionId) {
    targets.push({
      kind: "ai",
      problemRef: opts.aiProblemRef,
      versionId: opts.aiVersionId,
    });
  }
  if (targets.length === 0) return [];

  const endpoint = `${opts.baseUrl}/api/v1/domains/${
    encodeURIComponent(opts.domainSlug)
  }/submissions`;
  const seededIds: string[] = [];

  await Promise.all(
    Array.from({ length: opts.count }, async (_, seedIdx) => {
      const target = targets[seedIdx % targets.length]!;
      const headers = opts
        .userHeadersList[seedIdx % opts.userHeadersList.length]!;
      const seedTag = `stress-seed-${opts.runNonce}-${seedIdx}`;
      const payload = target.kind === "ai"
        ? {
          problem_ref: target.problemRef,
          version_id: target.versionId,
          language: "python3",
          code: `# ${seedTag}\ndef solve(x):\n    return x\n`,
        }
        : {
          problem_ref: target.problemRef,
          version_id: target.versionId,
          language: "cc",
          code:
            `// ${seedTag}\n#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;return 0;}\n`,
        };

      const deadline = performance.now() + opts.timeoutMs;
      let submissionId: string | undefined;
      try {
        submissionId = await runWithDeadline(
          deadline - performance.now(),
          async (signal) => {
            const res = await opts.fetchImpl(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(payload),
              signal,
            });
            if (res.status !== 201 && res.status !== 200) {
              await res.body?.cancel().catch(() => {});
              return undefined;
            }
            const body = await res.json() as {
              data?: { id?: string };
              id?: string;
            };
            return body.data?.id ?? body.id;
          },
        );
      } catch {
        return;
      }
      if (!submissionId) return;

      const pollUrl = `${opts.baseUrl}/api/v1/domains/${
        encodeURIComponent(opts.domainSlug)
      }/submissions/${encodeURIComponent(submissionId)}`;
      while (performance.now() < deadline) {
        const pollResp = await fetchJsonWithDeadline<{
          status?: string;
          data?: { status?: string };
        }>(deadline, opts.withPollSlot, opts.fetchImpl, pollUrl, headers);
        if (pollResp.ok) {
          const status = pollResp.data.data?.status ?? pollResp.data.status;
          if (status === "finished") {
            seededIds.push(submissionId);
            return;
          }
          if (status === "error") return;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        await new Promise((r) =>
          setTimeout(r, Math.min(opts.pollIntervalMs, remaining))
        );
      }
    }),
  );

  return seededIds;
}
