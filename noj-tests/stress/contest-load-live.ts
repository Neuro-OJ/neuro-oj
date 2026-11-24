/**
 * 模拟赛压测真实测试环境（--live）HTTP 并发执行器。
 *
 * 严格对齐后端显式域路由契约：
 * - 多用户独立认证池：避免 `--users > 1` 共用单账号触发 `noj-judge` 的 `user_busy` 串行锁
 * - 两阶段并发流水线：突发 POST 调度发送与异步结果轮询解耦，慢评测不阻塞突发波峰投递
 * - 题目版本解析：`GET /api/v1/domains/:slug/problems/:reference`
 * - 普通域提交：`POST /api/v1/domains/:slug/submissions`
 * - 竞赛域提交：`POST /api/v1/domains/:slug/contests/:id/problems/:label/submissions`
 * - 低优先级（low）队列：`POST /api/v1/domains/:slug/submission-jobs`（rejudge）
 */

import {
  type LoadTestConfig,
  type PriorityTier,
  round2,
  type SubmissionRecord,
  type WorkloadItem,
} from "./contest-load-types.ts";
import {
  buildAuthHeaders,
  createAuthRequestRunner,
  createSemaphore,
  ensureLiveDomainAndContestAccess,
  resolveLiveAuthPool,
  type SemaphoreRunner,
} from "./contest-load-auth.ts";
import {
  DeadlineTimeoutError,
  type LiveContext,
  parseIsoTimestampMs,
  type PendingPollJob,
  pollAcceptedJob,
  resolveSubmissionQueueWaitMs,
  runWithDeadline,
  seedRejudgeTargets,
} from "./contest-load-live-polling.ts";

export { parseIsoTimestampMs, resolveSubmissionQueueWaitMs };

type PostDispatchResult =
  | { accepted: true; job: PendingPollJob }
  | { accepted: false; record: SubmissionRecord };

function resolveUserHeaders(
  ctx: LiveContext,
  item: WorkloadItem,
): Record<string, string> {
  const mapped = ctx.userHeadersByUserId.get(item.userId);
  if (mapped) return mapped;
  return ctx.userHeadersList[item.index % ctx.userHeadersList.length] ??
    ctx.controlHeaders;
}

function makeErrorRecord(
  item: WorkloadItem,
  priority: PriorityTier,
  startedAt: number,
  submitHttpMs: number,
  httpStatus: number,
  outcome: SubmissionRecord["outcome"],
  error: string,
  sentAtMs?: number,
  acceptedAtMs?: number,
): SubmissionRecord {
  const nowRel = round2(performance.now() - startedAt);
  return {
    index: item.index,
    userId: item.userId,
    problemKind: item.problemKind,
    priority,
    sentAtMs: sentAtMs !== undefined ? round2(sentAtMs) : undefined,
    acceptedAtMs: acceptedAtMs !== undefined ? round2(acceptedAtMs) : undefined,
    submitHttpMs: round2(submitHttpMs),
    queueWaitMs: 0,
    e2eLatencyMs: round2(submitHttpMs),
    completedAtMs: acceptedAtMs !== undefined ? round2(acceptedAtMs) : nowRel,
    httpStatus,
    outcome,
    error,
  };
}

/** 压测启动前解析目标题目的当前作答 version_id（显式传入则直接使用）。 */
async function resolveLiveProblemVersion(
  fetchImpl: typeof fetch,
  baseUrl: string,
  domainSlug: string,
  problemRef: string,
  explicitVersionId: string | undefined,
  controlHeaders: Record<string, string>,
): Promise<string> {
  if (explicitVersionId && explicitVersionId.trim() !== "") {
    return explicitVersionId.trim();
  }
  const url = `${baseUrl}/api/v1/domains/${
    encodeURIComponent(domainSlug)
  }/problems/${encodeURIComponent(problemRef)}`;
  const res = await fetchImpl(url, { headers: controlHeaders });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(
      `解析题目 ${problemRef} 版本失败: HTTP ${res.status} ${
        txt.slice(0, 120)
      }`,
    );
  }
  const body = await res.json() as {
    version_id?: string;
    answer_version_id?: string;
    data?: { version_id?: string; answer_version_id?: string };
  };
  const resolved = body.version_id ?? body.answer_version_id ??
    body.data?.version_id ?? body.data?.answer_version_id;
  if (typeof resolved !== "string" || resolved.trim() === "") {
    throw new Error(`题目 ${problemRef} 响应缺少 version_id`);
  }
  return resolved;
}

interface ContestProblemItem {
  label?: string;
  problem_id?: string;
  problem_ref?: string;
  display_id?: string;
  version_id?: string | null;
  effective_version_policy?: {
    mode?: string;
    version_id?: string | null;
  };
  reference?: { display_ref?: string; problem_id?: string };
}

function extractContestProblemVersion(
  item: ContestProblemItem | undefined,
): string | undefined {
  if (!item) return undefined;
  if (typeof item.version_id === "string" && item.version_id.trim() !== "") {
    return item.version_id.trim();
  }
  const policyVer = item.effective_version_policy?.mode === "exact"
    ? item.effective_version_policy.version_id
    : undefined;
  return typeof policyVer === "string" && policyVer.trim() !== ""
    ? policyVer.trim()
    : undefined;
}

/** 最佳努力读取竞赛状态、赛题 label 与竞赛锁定 version_id，确保不误用练习最新版触发 409。 */
async function resolveLiveContestMeta(
  fetchImpl: typeof fetch,
  baseUrl: string,
  domainSlug: string,
  contestId: string,
  controlHeaders: Record<string, string>,
  aiProblemRef?: string,
  oiProblemRef?: string,
  explicitAiLabel?: string,
  explicitOiLabel?: string,
): Promise<{
  isRunning: boolean;
  aiLabel?: string;
  oiLabel?: string;
  aiVersionId?: string;
  oiVersionId?: string;
}> {
  let isRunning = true;
  const encodedSlug = encodeURIComponent(domainSlug);
  const encodedContest = encodeURIComponent(contestId);
  try {
    const contestRes = await fetchImpl(
      `${baseUrl}/api/v1/domains/${encodedSlug}/contests/${encodedContest}`,
      { headers: controlHeaders },
    );
    if (contestRes.ok) {
      const body = await contestRes.json() as {
        status?: string;
        data?: { status?: string };
      };
      const status = body.data?.status ?? body.status;
      if (typeof status === "string" && status !== "") {
        isRunning = status === "running";
      }
    } else {
      await contestRes.body?.cancel();
    }
  } catch {
    // 最小测试桩未提供竞赛元数据时默认按 running 竞赛处理
  }

  let aiLabel: string | undefined;
  let oiLabel: string | undefined;
  let aiVersionId: string | undefined;
  let oiVersionId: string | undefined;
  try {
    const problemsRes = await fetchImpl(
      `${baseUrl}/api/v1/domains/${encodedSlug}/contests/${encodedContest}/problems`,
      { headers: controlHeaders },
    );
    if (problemsRes.ok) {
      const body = await problemsRes.json() as {
        data?: ContestProblemItem[];
      };
      const items = Array.isArray(body.data) ? body.data : [];
      const matchItem = (
        ref?: string,
        fallbackLabel?: string,
      ): ContestProblemItem | undefined => {
        if (ref) {
          const byRef = items.find((item) =>
            item.display_id === ref ||
            item.problem_id === ref ||
            item.problem_ref === ref ||
            item.reference?.display_ref === ref ||
            item.reference?.problem_id === ref
          );
          if (byRef) return byRef;
        }
        if (fallbackLabel) {
          return items.find((item) => item.label === fallbackLabel);
        }
        return undefined;
      };
      const aiItem = matchItem(aiProblemRef, explicitAiLabel);
      const oiItem = matchItem(oiProblemRef, explicitOiLabel);
      aiLabel = typeof aiItem?.label === "string" ? aiItem.label : undefined;
      oiLabel = typeof oiItem?.label === "string" ? oiItem.label : undefined;
      aiVersionId = extractContestProblemVersion(aiItem);
      oiVersionId = extractContestProblemVersion(oiItem);
    } else {
      await problemsRes.body?.cancel();
    }
  } catch {
    // 忽略可选竞赛题表探测异常
  }

  const probeSingleContestProblem = async (
    label: string | undefined,
  ): Promise<string | undefined> => {
    if (!label) return undefined;
    try {
      const res = await fetchImpl(
        `${baseUrl}/api/v1/domains/${encodedSlug}/contests/${encodedContest}/problems/${
          encodeURIComponent(label)
        }`,
        { headers: controlHeaders },
      );
      if (!res.ok) {
        await res.body?.cancel();
        return undefined;
      }
      const body = await res.json() as {
        data?: ContestProblemItem;
      } & ContestProblemItem;
      return extractContestProblemVersion(body.data ?? body);
    } catch {
      return undefined;
    }
  };

  if (!aiVersionId) {
    aiVersionId = await probeSingleContestProblem(aiLabel ?? explicitAiLabel);
  }
  if (!oiVersionId) {
    oiVersionId = await probeSingleContestProblem(oiLabel ?? explicitOiLabel);
  }

  return { isRunning, aiLabel, oiLabel, aiVersionId, oiVersionId };
}

/** 最佳努力拉取当前域内已完结的历史提交 ID，作为 low 优先级重测候选目标。 */
async function fetchExistingRejudgeCandidates(
  fetchImpl: typeof fetch,
  baseUrl: string,
  domainSlug: string,
  controlHeaders: Record<string, string>,
): Promise<string[]> {
  try {
    const res = await fetchImpl(
      `${baseUrl}/api/v1/domains/${
        encodeURIComponent(domainSlug)
      }/submissions?kind=submission&per_page=20`,
      { headers: controlHeaders },
    );
    if (!res.ok) {
      await res.body?.cancel();
      return [];
    }
    const body = await res.json() as {
      data?: Array<{ id?: string; status?: string; kind?: string }>;
    };
    const items = Array.isArray(body.data) ? body.data : [];
    return items
      .filter((item) =>
        typeof item.id === "string" &&
        item.id !== "" &&
        (item.kind === undefined || item.kind === "submission") &&
        item.status === "finished"
      )
      .map((item) => item.id!);
  } catch {
    return [];
  }
}

/** 调度发送阶段：仅发送普通/竞赛提交 POST 请求，记录受理时间后立即交由轮询池跟踪。 */
async function dispatchSubmissionPost(
  item: WorkloadItem,
  ctx: LiveContext,
  withPostSlot?: SemaphoreRunner,
): Promise<PostDispatchResult> {
  const useContestRoute = item.priority === "high" && Boolean(ctx.contestId);
  // 与服务端 resolveJudgeTaskPriority 对齐：非竞赛或非进行中竞赛均为 medium
  const actualPriority: PriorityTier = useContestRoute && ctx.contestIsRunning
    ? "high"
    : "medium";

  const problemRef = item.problemKind === "ai"
    ? ctx.aiProblemRef
    : ctx.oiProblemRef;
  const versionId = useContestRoute
    ? (item.problemKind === "ai"
      ? (ctx.aiContestVersionId ?? ctx.aiVersionId)
      : (ctx.oiContestVersionId ?? ctx.oiVersionId))
    : (item.problemKind === "ai" ? ctx.aiVersionId : ctx.oiVersionId);
  if (!problemRef || !versionId) {
    return {
      accepted: false,
      record: makeErrorRecord(
        item,
        actualPriority,
        ctx.startedAt,
        0,
        0,
        "error",
        `缺少 ${item.problemKind} 题型 problemRef 或 version_id`,
      ),
    };
  }

  const contestLabel = item.problemKind === "ai"
    ? ctx.aiContestLabel
    : ctx.oiContestLabel;
  const endpoint = useContestRoute
    ? `${ctx.baseUrl}/api/v1/domains/${
      encodeURIComponent(ctx.domainSlug)
    }/contests/${encodeURIComponent(ctx.contestId!)}/problems/${
      encodeURIComponent(contestLabel)
    }/submissions`
    : `${ctx.baseUrl}/api/v1/domains/${
      encodeURIComponent(ctx.domainSlug)
    }/submissions`;

  const payload = item.problemKind === "ai"
    ? {
      problem_ref: problemRef,
      version_id: versionId,
      language: "python3",
      code: "def solve(x):\n    return x\n",
    }
    : {
      problem_ref: problemRef,
      version_id: versionId,
      language: "cc",
      code:
        "#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;return 0;}\n",
    };

  const headers = resolveUserHeaders(ctx, item);
  const reqStart = performance.now();
  const reqStartEpochMs = Date.now();
  const sentAtMs = reqStart - ctx.startedAt;
  const bodyJson = JSON.stringify(payload);
  try {
    return await runWithDeadline(ctx.timeoutMs, async (signal) => {
      const doFetch = () =>
        ctx.fetchImpl(endpoint, {
          method: "POST",
          headers,
          body: bodyJson,
          signal,
        });
      const res = withPostSlot
        ? await withPostSlot(doFetch, { signal })
        : await doFetch();

      const acceptedAt = performance.now();
      const acceptedAtMs = acceptedAt - ctx.startedAt;
      const submitHttpMs = acceptedAt - reqStart;

      if (res.status === 429) {
        await res.body?.cancel().catch(() => {});
        return {
          accepted: false as const,
          record: makeErrorRecord(
            item,
            actualPriority,
            ctx.startedAt,
            submitHttpMs,
            429,
            "rate_limited",
            "HTTP 429",
            sentAtMs,
            acceptedAtMs,
          ),
        };
      }
      if (res.status === 503) {
        await res.body?.cancel().catch(() => {});
        return {
          accepted: false as const,
          record: makeErrorRecord(
            item,
            actualPriority,
            ctx.startedAt,
            submitHttpMs,
            503,
            "backpressure",
            "HTTP 503",
            sentAtMs,
            acceptedAtMs,
          ),
        };
      }
      if (res.status !== 201 && res.status !== 200) {
        const txt = await res.text();
        return {
          accepted: false as const,
          record: makeErrorRecord(
            item,
            actualPriority,
            ctx.startedAt,
            submitHttpMs,
            res.status,
            "error",
            `HTTP ${res.status}: ${txt.slice(0, 120)}`,
            sentAtMs,
            acceptedAtMs,
          ),
        };
      }

      const body = await res.json() as {
        data?: { id?: string; created_at?: string | null };
        id?: string;
        created_at?: string | null;
      };
      const submissionId = body.data?.id ?? body.id;
      if (!submissionId) {
        return {
          accepted: false as const,
          record: makeErrorRecord(
            item,
            actualPriority,
            ctx.startedAt,
            submitHttpMs,
            res.status,
            "error",
            "提交响应缺少 submission id",
            sentAtMs,
            acceptedAtMs,
          ),
        };
      }
      const createdAtEpochMs = parseIsoTimestampMs(
        body.data?.created_at ?? body.created_at,
      ) ?? undefined;

      return {
        accepted: true as const,
        job: {
          kind: "submission" as const,
          item,
          actualPriority,
          targetId: submissionId,
          headers,
          reqStart,
          reqStartEpochMs,
          createdAtEpochMs,
          sentAtMs,
          acceptedAtMs,
          submitHttpMs,
          httpStatus: res.status,
        },
      };
    });
  } catch (err) {
    const acceptedAt = performance.now();
    const isTimeout = err instanceof DeadlineTimeoutError;
    return {
      accepted: false,
      record: makeErrorRecord(
        item,
        actualPriority,
        ctx.startedAt,
        acceptedAt - reqStart,
        0,
        isTimeout ? "timeout" : "error",
        isTimeout
          ? "提交 POST 请求超时"
          : `POST 请求异常: ${
            err instanceof Error ? err.message : String(err)
          }`,
        sentAtMs,
        acceptedAt - ctx.startedAt,
      ),
    };
  }
}

/** 调度发送阶段：仅发送域批量重测 POST 请求（触发真实 `low` 优先级队列）。 */
async function dispatchRejudgePost(
  item: WorkloadItem,
  ctx: LiveContext,
  withPostSlot?: SemaphoreRunner,
): Promise<PostDispatchResult> {
  const targetId = ctx.rejudgePool.length === 0
    ? null
    : ctx.rejudgePool[(ctx.rejudgeCursor++) % ctx.rejudgePool.length]!;
  if (!targetId) {
    return {
      accepted: false,
      record: makeErrorRecord(
        item,
        "low",
        ctx.startedAt,
        0,
        0,
        "error",
        "缺少可用的已完成提交以触发 low 优先级重测（请先创建提交或传入 --rejudge-submission-id）",
      ),
    };
  }

  const reqStart = performance.now();
  const reqStartEpochMs = Date.now();
  const sentAtMs = reqStart - ctx.startedAt;
  const endpoint = `${ctx.baseUrl}/api/v1/domains/${
    encodeURIComponent(ctx.domainSlug)
  }/submission-jobs`;
  const bodyJson = JSON.stringify({
    kind: "rejudge",
    scope: {
      type: "selected",
      submissions: [{ kind: "submission", id: targetId }],
    },
    target: { mode: "submitted" },
    policy_changes: [],
  });
  try {
    return await runWithDeadline(ctx.timeoutMs, async (signal) => {
      const doFetch = () =>
        ctx.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            ...ctx.controlHeaders,
            "Idempotency-Key": `stress-rejudge-${ctx.runNonce}-${item.index}`,
          },
          body: bodyJson,
          signal,
        });
      const res = withPostSlot
        ? await withPostSlot(doFetch, { signal })
        : await doFetch();

      const acceptedAt = performance.now();
      const acceptedAtMs = acceptedAt - ctx.startedAt;
      const submitHttpMs = acceptedAt - reqStart;

      if (res.status === 429) {
        await res.body?.cancel().catch(() => {});
        return {
          accepted: false as const,
          record: makeErrorRecord(
            item,
            "low",
            ctx.startedAt,
            submitHttpMs,
            429,
            "rate_limited",
            "HTTP 429",
            sentAtMs,
            acceptedAtMs,
          ),
        };
      }
      if (res.status === 503) {
        await res.body?.cancel().catch(() => {});
        return {
          accepted: false as const,
          record: makeErrorRecord(
            item,
            "low",
            ctx.startedAt,
            submitHttpMs,
            503,
            "backpressure",
            "HTTP 503",
            sentAtMs,
            acceptedAtMs,
          ),
        };
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => {});
        return {
          accepted: false as const,
          record: makeErrorRecord(
            item,
            "low",
            ctx.startedAt,
            submitHttpMs,
            res.status,
            "error",
            `无权调用域重测接口触发 low 优先级队列 (HTTP ${res.status})`,
            sentAtMs,
            acceptedAtMs,
          ),
        };
      }
      if (res.status !== 202 && res.status !== 200 && res.status !== 201) {
        const txt = await res.text();
        return {
          accepted: false as const,
          record: makeErrorRecord(
            item,
            "low",
            ctx.startedAt,
            submitHttpMs,
            res.status,
            "error",
            `HTTP ${res.status}: ${txt.slice(0, 120)}`,
            sentAtMs,
            acceptedAtMs,
          ),
        };
      }

      const body = await res.json() as {
        data?: { job_id?: string };
        job_id?: string;
      };
      const jobId = body.data?.job_id ?? body.job_id;
      if (!jobId) {
        return {
          accepted: false as const,
          record: makeErrorRecord(
            item,
            "low",
            ctx.startedAt,
            submitHttpMs,
            res.status,
            "error",
            "重测响应缺少 job_id",
            sentAtMs,
            acceptedAtMs,
          ),
        };
      }

      return {
        accepted: true as const,
        job: {
          kind: "rejudge" as const,
          item,
          actualPriority: "low" as const,
          targetId: jobId,
          sourceSubmissionId: targetId,
          headers: ctx.controlHeaders,
          reqStart,
          reqStartEpochMs,
          sentAtMs,
          acceptedAtMs,
          submitHttpMs,
          httpStatus: res.status,
        },
      };
    });
  } catch (err) {
    const acceptedAt = performance.now();
    const isTimeout = err instanceof DeadlineTimeoutError;
    return {
      accepted: false,
      record: makeErrorRecord(
        item,
        "low",
        ctx.startedAt,
        acceptedAt - reqStart,
        0,
        isTimeout ? "timeout" : "error",
        isTimeout
          ? "重测 POST 请求超时"
          : `重测 POST 请求异常: ${
            err instanceof Error ? err.message : String(err)
          }`,
        sentAtMs,
        acceptedAt - ctx.startedAt,
      ),
    };
  }
}

/** 真实测试环境 HTTP 并发压测执行器（两阶段流水线：调度发送 POST + 独立异步轮询）。 */
export async function executeLiveLoadTest(
  config: LoadTestConfig,
  plan: WorkloadItem[],
): Promise<{ records: SubmissionRecord[]; wallMs: number }> {
  const fetchImpl = config.fetchFn ?? globalThis.fetch;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const domainSlug = (config.domainSlug ?? "main").trim() || "main";
  const runNonce = crypto.randomUUID().slice(0, 8);
  const authFetch = createAuthRequestRunner(fetchImpl, {
    paceMs: config.authPaceMs ?? (config.fetchFn ? 0 : 100),
    maxRetries: config.authMaxRetries ?? 6,
  });

  const authPool = await resolveLiveAuthPool(
    config,
    fetchImpl,
    baseUrl,
    runNonce,
    authFetch,
  );
  await ensureLiveDomainAndContestAccess({
    authFetch,
    baseUrl,
    domainSlug,
    contestId: config.contestId,
    controlToken: authPool.controlToken,
    userTokens: authPool.userTokens,
  });

  const controlHeaders = buildAuthHeaders(authPool.controlToken);
  const userHeadersList = authPool.userTokens.map(buildAuthHeaders);
  const userHeadersByUserId = new Map<string, Record<string, string>>();
  for (const item of plan) {
    if (!userHeadersByUserId.has(item.userId)) {
      const idx = userHeadersByUserId.size % userHeadersList.length;
      userHeadersByUserId.set(item.userId, userHeadersList[idx]!);
    }
  }

  const lowCount = plan.filter((item) => item.priority === "low").length;
  const hasLow = lowCount > 0;
  const hasNonLow = plan.some((item) => item.priority !== "low");
  const rejudgePool: string[] = [...(config.rejudgeSubmissionIds ?? [])];
  if (hasLow && rejudgePool.length < lowCount) {
    const existing = await fetchExistingRejudgeCandidates(
      fetchImpl,
      baseUrl,
      domainSlug,
      controlHeaders,
    );
    for (const id of existing) {
      if (!rejudgePool.includes(id)) rejudgePool.push(id);
    }
  }
  const needsSeed = hasLow && hasNonLow && rejudgePool.length < lowCount;

  // 分别解析：1) 普通练习提交使用的练习 version_id；2) 竞赛锁定使用的竞赛 version_id
  const needPracticeAi = Boolean(config.aiProblemId) && (
    plan.some((item) =>
      item.problemKind === "ai" &&
      (item.priority === "medium" ||
        (item.priority === "high" && !config.contestId))
    ) ||
    (needsSeed &&
      (!config.oiProblemId || plan.some((i) => i.problemKind === "ai")))
  );
  const needPracticeOi = Boolean(config.oiProblemId) && (
    plan.some((item) =>
      item.problemKind === "oi" &&
      (item.priority === "medium" ||
        (item.priority === "high" && !config.contestId))
    ) ||
    needsSeed
  );

  const aiVersionId = needPracticeAi && config.aiProblemId
    ? await resolveLiveProblemVersion(
      fetchImpl,
      baseUrl,
      domainSlug,
      config.aiProblemId,
      config.aiVersionId ?? config.versionId,
      controlHeaders,
    )
    : (config.aiVersionId ?? config.versionId);
  const oiVersionId = needPracticeOi && config.oiProblemId
    ? await resolveLiveProblemVersion(
      fetchImpl,
      baseUrl,
      domainSlug,
      config.oiProblemId,
      config.oiVersionId ?? config.versionId,
      controlHeaders,
    )
    : (config.oiVersionId ?? config.versionId);

  const contestMeta = config.contestId &&
      plan.some((item) => item.priority === "high")
    ? await resolveLiveContestMeta(
      fetchImpl,
      baseUrl,
      domainSlug,
      config.contestId,
      controlHeaders,
      config.aiProblemId,
      config.oiProblemId,
      config.aiContestLabel,
      config.oiContestLabel,
    )
    : {
      isRunning: true,
      aiLabel: undefined,
      oiLabel: undefined,
      aiVersionId: undefined,
      oiVersionId: undefined,
    };

  const aiContestVersionId = config.aiContestVersionId?.trim() ||
    config.contestVersionId?.trim() ||
    contestMeta.aiVersionId ||
    aiVersionId;
  const oiContestVersionId = config.oiContestVersionId?.trim() ||
    config.contestVersionId?.trim() ||
    contestMeta.oiVersionId ||
    oiVersionId;

  const defaultConcurrency = Math.min(Math.max(config.users * 2, 32), 128);
  const withPostSlot = createSemaphore(
    config.postConcurrency ?? defaultConcurrency,
  );
  const withPollSlot = createSemaphore(
    config.pollConcurrency ?? defaultConcurrency,
  );

  // 若混合负载包含 low 档且重测目标不足，先在计时突发窗口之前预热 seed 普通提交（不计入压测 samples）
  if (needsSeed) {
    const seededIds = await seedRejudgeTargets({
      count: lowCount - rejudgePool.length,
      fetchImpl,
      baseUrl,
      domainSlug,
      userHeadersList,
      aiProblemRef: config.aiProblemId,
      oiProblemRef: config.oiProblemId,
      aiVersionId,
      oiVersionId,
      pollIntervalMs: config.pollIntervalMs,
      timeoutMs: config.timeoutMs,
      withPollSlot,
      runNonce,
    });
    for (const id of seededIds) {
      if (!rejudgePool.includes(id)) rejudgePool.push(id);
    }
  }

  const startedAt = performance.now();
  const ctx: LiveContext = {
    baseUrl,
    domainSlug,
    controlHeaders,
    userHeadersList,
    userHeadersByUserId,
    fetchImpl,
    startedAt,
    pollIntervalMs: config.pollIntervalMs,
    timeoutMs: config.timeoutMs,
    contestId: config.contestId,
    contestIsRunning: contestMeta.isRunning,
    aiProblemRef: config.aiProblemId,
    oiProblemRef: config.oiProblemId,
    aiVersionId,
    oiVersionId,
    aiContestVersionId,
    oiContestVersionId,
    aiContestLabel: config.aiContestLabel ?? contestMeta.aiLabel ?? "A",
    oiContestLabel: config.oiContestLabel ?? contestMeta.oiLabel ?? "A",
    rejudgePool,
    rejudgeCursor: 0,
    runNonce,
  };

  const records: SubmissionRecord[] = [];
  const runBatch = async (items: WorkloadItem[]): Promise<void> => {
    if (items.length === 0) return;
    const batchStartedAt = performance.now();
    const pollPromises: Promise<void>[] = [];

    // 阶段 1：按 burstWindowMs 时序独立调度所有 POST 请求（受并发连接上限控制），不被慢轮询阻塞
    const dispatchPromises = items.map(async (item, pos) => {
      const targetOffsetMs = config.burstWindowMs > 0 && items.length > 1
        ? (pos / (items.length - 1)) * config.burstWindowMs
        : 0;
      if (targetOffsetMs > 0) {
        const waitMs = batchStartedAt + targetOffsetMs - performance.now();
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }

      const dispatchResult = item.priority === "low"
        ? await dispatchRejudgePost(item, ctx, withPostSlot)
        : await dispatchSubmissionPost(item, ctx, withPostSlot);

      if (!dispatchResult.accepted) {
        records.push(dispatchResult.record);
        return;
      }

      // 阶段 2：已受理任务立即进入独立异步并发轮询池跟踪终态
      pollPromises.push(
        pollAcceptedJob(dispatchResult.job, ctx, withPollSlot).then((rec) => {
          records.push(rec);
        }),
      );
    });

    await Promise.all(dispatchPromises);
    await Promise.all(pollPromises);
  };

  // 所有优先级的压测请求（high + medium + low）在同一个突发窗口内真正并发混合投递
  await runBatch(plan);

  return { records, wallMs: performance.now() - startedAt };
}
