/**
 * 高并发模拟赛压测套件（支持 --dry-run Mock 模式与真实测试环境 HTTP 模式）。
 *
 * 覆盖：
 * - 可配置并发用户数、波峰提交量、AI / OI 混合题型比例；
 * - 三级优先级队列（high / medium / low = 4:2:1）权重与非饥饿验证；
 * - P50 / P95 / P99 端到端评测延迟、排队等待延迟与吞吐统计；
 * - 限流（HTTP 429）与背压（HTTP 503）观测及告警阈值判定。
 */

import {
  defaultLoadTestConfig,
  type LatencySummary,
  type LoadTestConfig,
  type LoadTestReport,
  type LoadTestStats,
  type LoadThresholds,
  type MockTransportProfile,
  type PriorityFairnessReport,
  type PriorityMix,
  type PriorityTier,
  type ProblemKind,
  round2,
  type SubmissionRecord,
  type ThresholdEvaluation,
  type TierStats,
  type UserCredentialEntry,
  type WorkloadItem,
} from "./contest-load-types.ts";
import { executeLiveLoadTest } from "./contest-load-live.ts";

export {
  defaultLoadTestConfig,
  type LatencySummary,
  type LoadTestConfig,
  type LoadTestReport,
  type LoadTestStats,
  type LoadThresholds,
  type MockTransportProfile,
  type PriorityFairnessReport,
  type PriorityMix,
  type PriorityTier,
  type ProblemKind,
  type SubmissionRecord,
  type ThresholdEvaluation,
  type TierStats,
  type UserCredentialEntry,
  type WorkloadItem,
};

/** 计算有序数组或无序数组的百分位数（线性插值，p 范围 0..100）。 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  if (p <= 0) return Math.min(...values);
  if (p >= 100) return Math.max(...values);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lowVal = sorted[lower] ?? 0;
  const highVal = sorted[upper] ?? lowVal;
  if (lower === upper) return round2(lowVal);
  const weight = rank - lower;
  return round2(lowVal + (highVal - lowVal) * weight);
}

/** 统计延迟摘要（仅对有效样本计算，空样本全 0）。 */
export function summarizeLatencies(values: readonly number[]): LatencySummary {
  if (values.length === 0) {
    return { min: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    min: round2(sorted[0] ?? 0),
    avg: round2(sum / sorted.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: round2(sorted[sorted.length - 1] ?? 0),
  };
}

function buildTierStats(records: readonly SubmissionRecord[]): TierStats {
  const succeeded = records.filter((r) => r.outcome === "ok");
  const total = records.length;
  return {
    total,
    succeeded: succeeded.length,
    failed: total - succeeded.length,
    completionRate: total === 0 ? 1 : round2(succeeded.length / total),
    e2eLatencyMs: summarizeLatencies(succeeded.map((r) => r.e2eLatencyMs)),
    queueWaitMs: summarizeLatencies(succeeded.map((r) => r.queueWaitMs)),
  };
}

/**
 * 评估三级优先级（high:medium:low = 4:2:1）调度公平性与非饥饿情况。
 *
 * 1. 当高/低优先级同时存在样本时，high 的平均排队时间应显著不高于 low（允许极短延迟下的小幅抖动）；
 * 2. low 队列完成率必须不低于 `minLowCompletionRate`，防止高优先级洪峰导致饿死。
 */
export function evaluatePriorityFairness(
  records: readonly SubmissionRecord[],
  minLowCompletionRate: number,
): PriorityFairnessReport {
  const okRecords = records.filter((r) => r.outcome === "ok");
  const byTier: Record<PriorityTier, SubmissionRecord[]> = {
    high: okRecords.filter((r) => r.priority === "high"),
    medium: okRecords.filter((r) => r.priority === "medium"),
    low: okRecords.filter((r) => r.priority === "low"),
  };

  const allLow = records.filter((r) => r.priority === "low");
  const lowCompletionRate = allLow.length === 0
    ? 1
    : byTier.low.length / allLow.length;
  const lowStarved = allLow.length > 0 &&
    lowCompletionRate < minLowCompletionRate;

  const highAvgWait = byTier.high.length === 0
    ? 0
    : byTier.high.reduce((s, r) => s + r.queueWaitMs, 0) / byTier.high.length;
  const lowAvgWait = byTier.low.length === 0
    ? 0
    : byTier.low.reduce((s, r) => s + r.queueWaitMs, 0) / byTier.low.length;

  const highToLowWaitRatio = lowAvgWait === 0
    ? 1
    : round2(highAvgWait / lowAvgWait);

  // 取按完成时间排序的前 50% 样本观测早期竞争窗口优先级占比
  const sortedByComplete = [...okRecords].sort((a, b) =>
    a.completedAtMs - b.completedAtMs
  );
  const earlySlice = sortedByComplete.slice(
    0,
    Math.ceil(sortedByComplete.length / 2),
  );
  const earlyWindowCounts: Record<PriorityTier, number> = {
    high: earlySlice.filter((r) => r.priority === "high").length,
    medium: earlySlice.filter((r) => r.priority === "medium").length,
    low: earlySlice.filter((r) => r.priority === "low").length,
  };

  const notes: string[] = [];
  let fairnessPassed = !lowStarved;
  if (lowStarved) {
    notes.push(
      `low 优先级完成率 ${(lowCompletionRate * 100).toFixed(1)}% 低于门限 ${
        (minLowCompletionRate * 100).toFixed(1)
      }%（发生饥饿）`,
    );
  }
  if (
    byTier.high.length > 0 && byTier.low.length > 0 &&
    lowAvgWait >= 20 && highAvgWait > lowAvgWait * 1.15
  ) {
    fairnessPassed = false;
    notes.push(
      `high 平均排队 (${round2(highAvgWait)}ms) 明显高于 low (${
        round2(lowAvgWait)
      }ms)，优先级权重 4:2:1 未生效`,
    );
  } else if (byTier.high.length > 0 && byTier.low.length > 0) {
    notes.push(
      `high 平均排队 ${round2(highAvgWait)}ms，low 平均排队 ${
        round2(lowAvgWait)
      }ms（high/low=${highToLowWaitRatio}）`,
    );
  }

  return {
    fairnessPassed,
    lowStarved,
    highToLowWaitRatio,
    earlyWindowCounts,
    notes,
  };
}

/** 汇总压测统计指标。 */
export function computeLoadStats(
  records: readonly SubmissionRecord[],
  totalWallMs: number,
  minLowCompletionRate = 0.95,
): LoadTestStats {
  const succeeded = records.filter((r) => r.outcome === "ok");
  const totalSubmissions = records.length;
  const failed = totalSubmissions - succeeded.length;
  const wallSeconds = Math.max(totalWallMs, 1) / 1000;

  return {
    totalSubmissions,
    succeeded: succeeded.length,
    failed,
    errorRate: totalSubmissions === 0 ? 0 : failed / totalSubmissions,
    rateLimited429: records.filter((r) => r.outcome === "rate_limited").length,
    backpressure503: records.filter((r) => r.outcome === "backpressure").length,
    timeouts: records.filter((r) => r.outcome === "timeout").length,
    totalWallMs: round2(totalWallMs),
    throughputPerSec: round2(succeeded.length / wallSeconds),
    e2eLatencyMs: summarizeLatencies(succeeded.map((r) => r.e2eLatencyMs)),
    queueWaitMs: summarizeLatencies(succeeded.map((r) => r.queueWaitMs)),
    byProblemKind: {
      ai: buildTierStats(records.filter((r) => r.problemKind === "ai")),
      oi: buildTierStats(records.filter((r) => r.problemKind === "oi")),
    },
    byPriority: {
      high: buildTierStats(records.filter((r) => r.priority === "high")),
      medium: buildTierStats(records.filter((r) => r.priority === "medium")),
      low: buildTierStats(records.filter((r) => r.priority === "low")),
    },
    priorityFairness: evaluatePriorityFairness(records, minLowCompletionRate),
  };
}

/** 校验压测指标是否满足告警阈值。 */
export function evaluateLoadThresholds(
  stats: LoadTestStats,
  thresholds: LoadThresholds,
): ThresholdEvaluation {
  const violations: string[] = [];
  const warnings: string[] = [];

  if (stats.errorRate > thresholds.maxErrorRate) {
    violations.push(
      `错误率 ${(stats.errorRate * 100).toFixed(2)}% 超过阈值 ${
        (thresholds.maxErrorRate * 100).toFixed(2)
      }%`,
    );
  }
  if (stats.e2eLatencyMs.p95 > thresholds.maxP95Ms) {
    violations.push(
      `P95 延迟 ${stats.e2eLatencyMs.p95}ms 超过阈值 ${thresholds.maxP95Ms}ms`,
    );
  }
  if (stats.e2eLatencyMs.p99 > thresholds.maxP99Ms) {
    violations.push(
      `P99 延迟 ${stats.e2eLatencyMs.p99}ms 超过阈值 ${thresholds.maxP99Ms}ms`,
    );
  }
  if (!stats.priorityFairness.fairnessPassed) {
    violations.push(...stats.priorityFairness.notes);
  }
  if (stats.rateLimited429 > 0) {
    warnings.push(`观测到 ${stats.rateLimited429} 次 HTTP 429 限流响应`);
  }
  if (stats.backpressure503 > 0) {
    warnings.push(`观测到 ${stats.backpressure503} 次 HTTP 503 队列背压拒流`);
  }

  return {
    passed: violations.length === 0,
    violations,
    warnings,
  };
}

/** 按配置比例确定性地生成混合题型与优先级任务序列。 */
export function buildWorkloadPlan(config: LoadTestConfig): Array<{
  index: number;
  userId: string;
  problemKind: ProblemKind;
  priority: PriorityTier;
}> {
  const total = config.peakSubmissions;
  const users = Math.max(1, config.users);
  const aiTarget = Math.round(total * Math.min(1, Math.max(0, config.aiRatio)));

  const mixSum = config.priorityMix.high + config.priorityMix.medium +
    config.priorityMix.low;
  const normHigh = mixSum <= 0 ? 0.57 : config.priorityMix.high / mixSum;
  const normMed = mixSum <= 0 ? 0.29 : config.priorityMix.medium / mixSum;

  const highCount = Math.round(total * normHigh);
  const medCount = Math.min(total - highCount, Math.round(total * normMed));
  const lowCount = Math.max(0, total - highCount - medCount);

  const remaining: Record<PriorityTier, number> = {
    high: highCount,
    medium: medCount,
    low: lowCount,
  };
  const slotPattern: PriorityTier[] = [
    "high",
    "high",
    "high",
    "high",
    "medium",
    "medium",
    "low",
  ];
  const priorities: PriorityTier[] = [];
  let slotIdx = 0;
  while (priorities.length < total) {
    let picked: PriorityTier | null = null;
    for (let attempt = 0; attempt < slotPattern.length; attempt++) {
      const candidate = slotPattern[(slotIdx + attempt) % slotPattern.length]!;
      if (remaining[candidate] > 0) {
        picked = candidate;
        remaining[candidate]--;
        slotIdx = (slotIdx + attempt + 1) % slotPattern.length;
        break;
      }
    }
    if (picked === null) {
      // 兜底：若某个配额超调导致未命中，从剩余任意槽位补齐
      for (const tier of ["high", "medium", "low"] as const) {
        if (remaining[tier] > 0) {
          picked = tier;
          remaining[tier]--;
          break;
        }
      }
    }
    priorities.push(picked ?? "medium");
  }

  // 平滑交错分配 AI/OI 与用户，保证波峰内同时存在 high / medium / low 竞争
  const plan: Array<{
    index: number;
    userId: string;
    problemKind: ProblemKind;
    priority: PriorityTier;
  }> = [];

  for (let i = 0; i < total; i++) {
    const kind: ProblemKind = i < aiTarget ? "ai" : "oi";
    plan.push({
      index: i,
      userId: `load_user_${i % users}`,
      problemKind: kind,
      priority: priorities[i]!,
    });
  }
  return plan;
}

/** 与 `noj-judge/src/mq.rs` 对齐的 4:2:1 轮转序列。 */
const PRIORITY_ROTATION: readonly PriorityTier[] = [
  "high",
  "high",
  "high",
  "high",
  "medium",
  "medium",
  "low",
];

/**
 * 离线 Dry-Run 仿真运输器：按 4:2:1 优先级队列与有限 Worker 槽位模拟真实并发评测、
 * 限流（429）和队列背压（503）。
 */
async function executeMockLoadTest(
  config: LoadTestConfig,
  plan: ReturnType<typeof buildWorkloadPlan>,
): Promise<{ records: SubmissionRecord[]; wallMs: number }> {
  const profile = config.mockProfile ?? {};
  const workers = Math.max(1, profile.workerSlots ?? 4);
  const aiBaseMs = profile.aiBaseJudgeMs ?? 35;
  const oiBaseMs = profile.oiBaseJudgeMs ?? 18;
  const backpressureLimit = profile.backpressureQueueLimit ??
    Number.POSITIVE_INFINITY;
  const burstLimit = profile.rateLimitBurstThreshold ??
    Number.POSITIVE_INFINITY;
  const injectedFailureRate = profile.injectedFailureRate ?? 0;

  const queues: Record<
    PriorityTier,
    Array<{
      item: (typeof plan)[number];
      enqueuedAtMs: number;
      submitHttpMs: number;
    }>
  > = {
    high: [],
    medium: [],
    low: [],
  };

  const startMs = performance.now();
  const immediateRecords: SubmissionRecord[] = [];
  const stepDelay = config.burstWindowMs > 0 && plan.length > 1
    ? config.burstWindowMs / plan.length
    : 0;

  // 1. 波峰并发投递阶段（检测 429 限流与 503 背压）
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i]!;
    if (stepDelay > 0 && i > 0) {
      await new Promise((r) => setTimeout(r, Math.min(2, stepDelay)));
    }
    const enqueuedAtMs = performance.now() - startMs;
    const activeDepth = queues.high.length + queues.medium.length +
      queues.low.length;

    if (i >= burstLimit) {
      immediateRecords.push({
        index: item.index,
        userId: item.userId,
        problemKind: item.problemKind,
        priority: item.priority,
        submitHttpMs: 2,
        queueWaitMs: 0,
        e2eLatencyMs: 2,
        completedAtMs: enqueuedAtMs + 2,
        httpStatus: 429,
        outcome: "rate_limited",
        error: "HTTP 429 Too Many Requests",
      });
      continue;
    }

    if (activeDepth >= backpressureLimit) {
      immediateRecords.push({
        index: item.index,
        userId: item.userId,
        problemKind: item.problemKind,
        priority: item.priority,
        submitHttpMs: 3,
        queueWaitMs: 0,
        e2eLatencyMs: 3,
        completedAtMs: enqueuedAtMs + 3,
        httpStatus: 503,
        outcome: "backpressure",
        error: "HTTP 503 Queue Backpressure",
      });
      continue;
    }

    queues[item.priority].push({
      item,
      enqueuedAtMs,
      submitHttpMs: 3 + (item.index % 4),
    });
  }

  // 2. 模拟 Worker 按 4:2:1 轮转从三个优先级队列出队并评测
  let cursor = 0;
  const workerAvailableAt = new Array<number>(workers).fill(
    performance.now() - startMs,
  );
  const judgeRecords: SubmissionRecord[] = [];
  let processed = 0;

  while (
    queues.high.length > 0 || queues.medium.length > 0 || queues.low.length > 0
  ) {
    let picked: (typeof queues.high)[number] | undefined;
    for (let offset = 0; offset < PRIORITY_ROTATION.length; offset++) {
      const slot =
        PRIORITY_ROTATION[(cursor + offset) % PRIORITY_ROTATION.length]!;
      if (queues[slot].length > 0) {
        picked = queues[slot].shift();
        cursor = (cursor + offset + 1) % PRIORITY_ROTATION.length;
        break;
      }
    }
    if (picked === undefined) break;

    // 选最早空闲的 Worker 槽位
    let earliestIdx = 0;
    for (let w = 1; w < workers; w++) {
      if (workerAvailableAt[w]! < workerAvailableAt[earliestIdx]!) {
        earliestIdx = w;
      }
    }
    const dispatchMs = Math.max(
      picked.enqueuedAtMs,
      workerAvailableAt[earliestIdx]!,
    );
    const judgeMs = (picked.item.problemKind === "ai" ? aiBaseMs : oiBaseMs) +
      (picked.item.index % 5) * 2;
    const completedAtMs = dispatchMs + judgeMs;
    workerAvailableAt[earliestIdx] = completedAtMs;

    const queueWaitMs = Math.max(0, dispatchMs - picked.enqueuedAtMs);
    const e2eLatencyMs = picked.submitHttpMs + queueWaitMs + judgeMs;
    const shouldFail = injectedFailureRate > 0 &&
      ((processed % Math.max(1, Math.round(1 / injectedFailureRate))) === 0);
    processed++;

    judgeRecords.push({
      index: picked.item.index,
      userId: picked.item.userId,
      problemKind: picked.item.problemKind,
      priority: picked.item.priority,
      submitHttpMs: picked.submitHttpMs,
      queueWaitMs: round2(queueWaitMs),
      e2eLatencyMs: round2(e2eLatencyMs),
      completedAtMs: round2(completedAtMs),
      httpStatus: shouldFail ? 500 : 201,
      outcome: shouldFail ? "error" : "ok",
      error: shouldFail ? "simulated judge error" : undefined,
    });
  }

  const maxSimComplete = judgeRecords.length === 0
    ? 0
    : Math.max(...judgeRecords.map((r) => r.completedAtMs));
  const realElapsed = performance.now() - startMs;
  return {
    records: [...immediateRecords, ...judgeRecords],
    wallMs: Math.max(realElapsed, maxSimComplete),
  };
}

/** 运行模拟赛压测并生成完整验收报告。 */
export async function runContestLoadTest(
  overrides: Partial<LoadTestConfig> = {},
): Promise<LoadTestReport> {
  const base = defaultLoadTestConfig();
  const config: LoadTestConfig = {
    ...base,
    ...overrides,
    priorityMix: { ...base.priorityMix, ...(overrides.priorityMix ?? {}) },
    thresholds: { ...base.thresholds, ...(overrides.thresholds ?? {}) },
  };
  const plan = buildWorkloadPlan(config);
  const { records, wallMs } = config.mode === "dry-run"
    ? await executeMockLoadTest(config, plan)
    : await executeLiveLoadTest(config, plan);

  const stats = computeLoadStats(
    records,
    wallMs,
    config.thresholds.minLowCompletionRate,
  );
  const evaluation = evaluateLoadThresholds(stats, config.thresholds);
  const {
    adminToken: _omitAdmin,
    userTokens: _omitUserTokens,
    userCredentials: _omitUserCredentials,
    fetchFn: _omitFetch,
    ...safeConfig
  } = config;
  void _omitAdmin;
  void _omitUserTokens;
  void _omitUserCredentials;
  void _omitFetch;

  return {
    mode: config.mode,
    executedAt: new Date().toISOString(),
    config: safeConfig,
    stats,
    evaluation,
  };
}

/** 解析 CLI 参数。 */
export function parseLoadTestArgs(args: readonly string[]): {
  config: Partial<LoadTestConfig>;
  json: boolean;
  help: boolean;
} {
  let json = false;
  let help = false;
  const config: Partial<LoadTestConfig> = {};
  const thresholds: Partial<LoadThresholds> = {};

  const nextVal = (i: number, flag: string): string => {
    const val = args[i + 1];
    if (val === undefined || val.startsWith("--")) {
      throw new Error(`${flag} 需要一个参数值`);
    }
    return val;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--dry-run") {
      config.mode = "dry-run";
    } else if (arg === "--live") {
      config.mode = "live";
    } else if (arg === "--base-url") {
      config.baseUrl = nextVal(i++, arg);
    } else if (arg === "--admin-token") {
      config.adminToken = nextVal(i++, arg);
    } else if (arg === "--user-tokens") {
      const tokens = nextVal(i++, arg)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      config.userTokens = [...(config.userTokens ?? []), ...tokens];
    } else if (arg === "--user-credentials-file") {
      config.userCredentialsFile = nextVal(i++, arg);
    } else if (arg === "--auto-register") {
      config.autoRegister = true;
    } else if (arg === "--allow-shared-user") {
      config.allowSharedUser = true;
    } else if (arg === "--domain") {
      config.domainSlug = nextVal(i++, arg);
    } else if (arg === "--contest-id") {
      config.contestId = nextVal(i++, arg);
    } else if (arg === "--ai-problem-id") {
      config.aiProblemId = nextVal(i++, arg);
    } else if (arg === "--oi-problem-id") {
      config.oiProblemId = nextVal(i++, arg);
    } else if (arg === "--version-id") {
      config.versionId = nextVal(i++, arg);
    } else if (arg === "--ai-version-id") {
      config.aiVersionId = nextVal(i++, arg);
    } else if (arg === "--oi-version-id") {
      config.oiVersionId = nextVal(i++, arg);
    } else if (arg === "--contest-version-id") {
      config.contestVersionId = nextVal(i++, arg);
    } else if (arg === "--auth-pace-ms") {
      config.authPaceMs = Number.parseInt(nextVal(i++, arg), 10);
    } else if (arg === "--auth-max-retries") {
      config.authMaxRetries = Number.parseInt(nextVal(i++, arg), 10);
    } else if (arg === "--ai-contest-label") {
      config.aiContestLabel = nextVal(i++, arg);
    } else if (arg === "--oi-contest-label") {
      config.oiContestLabel = nextVal(i++, arg);
    } else if (arg === "--rejudge-submission-id") {
      const ids = nextVal(i++, arg)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      config.rejudgeSubmissionIds = [
        ...(config.rejudgeSubmissionIds ?? []),
        ...ids,
      ];
    } else if (arg === "--users") {
      config.users = Number.parseInt(nextVal(i++, arg), 10);
    } else if (arg === "--peak-submissions") {
      config.peakSubmissions = Number.parseInt(nextVal(i++, arg), 10);
    } else if (arg === "--ai-ratio") {
      config.aiRatio = Number.parseFloat(nextVal(i++, arg));
    } else if (arg === "--burst-ms") {
      config.burstWindowMs = Number.parseInt(nextVal(i++, arg), 10);
    } else if (arg === "--max-p95-ms") {
      thresholds.maxP95Ms = Number.parseFloat(nextVal(i++, arg));
    } else if (arg === "--max-p99-ms") {
      thresholds.maxP99Ms = Number.parseFloat(nextVal(i++, arg));
    } else if (arg === "--max-error-rate") {
      thresholds.maxErrorRate = Number.parseFloat(nextVal(i++, arg));
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  if (Object.keys(thresholds).length > 0) {
    config.thresholds = {
      ...defaultLoadTestConfig().thresholds,
      ...thresholds,
    };
  }
  return { config, json, help };
}

function renderHelp(): string {
  return [
    "用法: deno run -A stress/contest-load-test.ts [选项]",
    "",
    "选项:",
    "  --dry-run                       离线仿真压测（默认，不依赖外部容器）",
    "  --live                          向真实测试环境发起并发提交压测",
    "  --base-url <url>                核心 API 地址（默认 $E2E_BASE_URL 或 http://localhost:8099）",
    "  --admin-token <jwt>             live 模式管理员/控制面 Token",
    "  --user-tokens <t1,t2,...>       多虚拟用户独立 JWT 列表（逗号分隔）",
    "  --user-credentials-file <path>  多用户凭据 JSON 文件（[{ token } | { login, password }]）",
    "  --auto-register                 自动通过注册或管理员开号为每个虚拟用户获取独立 Token",
    "  --allow-shared-user             显式允许 --users > 1 时共享单账号（否则拒绝假多用户并发）",
    "  --auth-pace-ms <ms>             准备期鉴权/入域/报名请求最小节流间隔（毫秒）",
    "  --auth-max-retries <n>          准备期遇 429 限流的最大退避重试次数（默认 6）",
    "  --domain <slug>                 live 模式使用域 slug（默认 main）",
    "  --contest-id <id>               live 模式竞赛 ID（high 优先级提交）",
    "  --ai-problem-id <ref>           live 模式 AI 题目引用",
    "  --oi-problem-id <ref>           live 模式 OI 题目引用",
    "  --version-id <id>               显式指定练习默认 version_id（省略时自动查询域题目解析）",
    "  --ai-version-id <id>            显式指定 AI 练习题目 version_id",
    "  --oi-version-id <id>            显式指定 OI 练习题目 version_id",
    "  --contest-version-id <id>       显式指定竞赛锁定 version_id（省略时从竞赛题表解析）",
    "  --ai-contest-label <label>      竞赛内 AI 题目标签（默认自动匹配或 A）",
    "  --oi-contest-label <label>      竞赛内 OI 题目标签（默认自动匹配或 A）",
    "  --rejudge-submission-id <id>    指定触发 low 优先级重测的提交 ID（可多次或逗号分隔）",
    "  --users <n>                     并发虚拟用户数（默认 20）",
    "  --peak-submissions <n>          波峰总提交量（默认 70）",
    "  --ai-ratio <0..1>               AI 题型比例（默认 0.5）",
    "  --burst-ms <ms>                 波峰投递时间窗口（默认 200）",
    "  --max-p95-ms <ms>               P95 延迟告警阈值",
    "  --max-p99-ms <ms>               P99 延迟告警阈值",
    "  --max-error-rate <0..1>         异常率告警阈值",
    "  --json                          输出 JSON 格式报告",
    "  -h, --help                      显示此帮助",
  ].join("\n");
}

if (import.meta.main) {
  const { config, json, help } = parseLoadTestArgs(Deno.args);
  if (help) {
    console.log(renderHelp());
    Deno.exit(0);
  }
  const report = await runContestLoadTest(config);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `[contest-load-test] mode=${report.mode} total=${report.stats.totalSubmissions} ok=${report.stats.succeeded} failed=${report.stats.failed} throughput=${report.stats.throughputPerSec}/s`,
    );
    console.log(
      `  e2e latency (ms): p50=${report.stats.e2eLatencyMs.p50} p95=${report.stats.e2eLatencyMs.p95} p99=${report.stats.e2eLatencyMs.p99}`,
    );
    console.log(
      `  backpressure: 429=${report.stats.rateLimited429} 503=${report.stats.backpressure503}`,
    );
    console.log(
      `  fairness: ${report.stats.priorityFairness.notes.join("; ")}`,
    );
    if (!report.evaluation.passed) {
      console.error(`FAIL: ${report.evaluation.violations.join(" | ")}`);
    } else {
      console.log("PASS: 所有压测指标与优先级公平性断言通过");
    }
  }
  if (!report.evaluation.passed) {
    Deno.exit(1);
  }
}
