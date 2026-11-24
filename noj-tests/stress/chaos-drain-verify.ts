/**
 * Worker 排空（drain）与队列重投恢复一致性演练校验器。
 *
 * 对齐 `noj-judge/src/mq.rs` 与 `noj-core/src/shared/mq/judge-queues.ts` 的 Redis 队列布局：
 * - 分池主队列（默认 `pools`）：`<prefix>:<pool>:<tier>`（pool 为 `ai` / `oi-wasm` / `oi-native`）
 * - 旧版主队列（`legacy`）：`<prefix>:<tier>`（`high` / `medium` / `low`）
 * - 进行中队列：`<queue>:processing`
 * - 资源等待状态键：`<prefix>:waiting:<submission_id>`
 * - 死信队列：`<queue>:dead`
 *
 * 验证两项核心混沌不变量：
 * 1. **优雅排空一致**：Worker 收到排空信号后不再领取新任务，在途 `:processing` 全部 ack 清除，
 *    `:waiting:*` 清理归零，剩余待评测任务完整保留在主队列。
 * 2. **中断重投幂等恢复**：Worker 非正常中断导致任务滞留 `:processing` 时，Sweeper 重投回主队列，
 *    恢复消费后所有队列归零且每个 `submission_id` 只落盘一次终态结果（无丢失、无重复结果）。
 */

export type QueuePriority = "high" | "medium" | "low";
export type QueuePool = "ai" | "oi-wasm" | "oi-native";
export const QUEUE_POOLS: readonly QueuePool[] = [
  "ai",
  "oi-wasm",
  "oi-native",
];
export type QueueLayout = "pools" | "legacy" | "both";

export interface QueuedJudgeTask {
  submissionId: string;
  runId: string;
  attemptId: string;
  priority: QueuePriority;
  requeueCount: number;
}

export interface PoolQueueStats {
  pendingByTier: Record<QueuePriority, number>;
  processingByTier: Record<QueuePriority, number>;
  deadByTier: Record<QueuePriority, number>;
  totalPending: number;
  totalProcessing: number;
  deadCount: number;
}

export interface RedisQueueSnapshot {
  pendingByTier: Record<QueuePriority, number>;
  processingByTier: Record<QueuePriority, number>;
  deadByTier?: Record<QueuePriority, number>;
  waitingKeys: string[];
  deadCount: number;
  totalPending: number;
  totalProcessing: number;
  queueLayout?: QueueLayout;
  byPool?: Record<QueuePool, PoolQueueStats>;
  legacy?: PoolQueueStats;
}

export interface ChaosVerifyResult {
  mode: "dry-run" | "live";
  passed: boolean;
  totalSubmitted: number;
  gracefulDrainChecked: boolean;
  requeuedCount: number;
  duplicateDeliveriesInjected: number;
  uniqueCompleted: number;
  duplicateResults: number;
  lostSubmissions: number;
  finalSnapshot: RedisQueueSnapshot;
  assertions: Array<{ name: string; passed: boolean; detail: string }>;
}

/** 抽象队列与状态后端，支持内存仿真与真实 Redis TCP 检查。 */
export interface ChaosQueueBackend {
  enqueue(task: QueuedJudgeTask): Promise<void>;
  /** RPOPLPUSH：从主队列移动到 `:processing`，并写 `:waiting:<submissionId>` 诊断键。 */
  pullToProcessing(priority: QueuePriority): Promise<QueuedJudgeTask | null>;
  /** LREM：成功投递结果后从 `:processing` 移除并清理 `:waiting` 键。 */
  ackProcessing(task: QueuedJudgeTask): Promise<void>;
  /** Sweeper：把滞留在 `:processing` 的任务重投回原优先级主队列。 */
  requeueStaleProcessing(): Promise<number>;
  /** 幂等结果消费端：按 `submissionId + runId` 去重写入终态结果，返回是否首次写入。 */
  commitResultIdempotent(task: QueuedJudgeTask): Promise<boolean>;
  /** 获取 Redis 状态快照（pending / processing / waiting / dead）。 */
  snapshot(): Promise<RedisQueueSnapshot>;
  /** 查询已落库唯一终态数与总结果事件数。 */
  resultStats(): Promise<{ uniqueCompleted: number; totalWritten: number }>;
}

/** 内存 Redis 仿真后端（用于 `--dry-run` 离线可重复校验）。 */
export class InMemoryChaosBackend implements ChaosQueueBackend {
  private pending: Record<QueuePriority, string[]> = {
    high: [],
    medium: [],
    low: [],
  };
  private processing: Record<QueuePriority, string[]> = {
    high: [],
    medium: [],
    low: [],
  };
  private dead: Record<QueuePriority, string[]> = {
    high: [],
    medium: [],
    low: [],
  };
  private waitingKeys = new Set<string>();
  private committedRuns = new Set<string>();
  private totalWritten = 0;

  constructor(private readonly prefix = "noj:judge:queue") {}

  enqueue(task: QueuedJudgeTask): Promise<void> {
    this.pending[task.priority].unshift(JSON.stringify(task));
    return Promise.resolve();
  }

  pullToProcessing(priority: QueuePriority): Promise<QueuedJudgeTask | null> {
    const raw = this.pending[priority].pop();
    if (raw === undefined) return Promise.resolve(null);
    this.processing[priority].unshift(raw);
    const parsed = JSON.parse(raw) as QueuedJudgeTask;
    this.waitingKeys.add(`${this.prefix}:waiting:${parsed.submissionId}`);
    return Promise.resolve(parsed);
  }

  ackProcessing(task: QueuedJudgeTask): Promise<void> {
    const list = this.processing[task.priority];
    const idx = list.findIndex((raw) => {
      const item = JSON.parse(raw) as QueuedJudgeTask;
      return item.submissionId === task.submissionId &&
        item.runId === task.runId;
    });
    if (idx >= 0) {
      list.splice(idx, 1);
    }
    this.waitingKeys.delete(`${this.prefix}:waiting:${task.submissionId}`);
    return Promise.resolve();
  }

  requeueStaleProcessing(): Promise<number> {
    let moved = 0;
    for (const tier of ["high", "medium", "low"] as const) {
      while (this.processing[tier].length > 0) {
        const raw = this.processing[tier].pop()!;
        const task = JSON.parse(raw) as QueuedJudgeTask;
        const nextTask: QueuedJudgeTask = {
          ...task,
          requeueCount: task.requeueCount + 1,
        };
        this.pending[tier].unshift(JSON.stringify(nextTask));
        this.waitingKeys.delete(`${this.prefix}:waiting:${task.submissionId}`);
        moved++;
      }
    }
    return Promise.resolve(moved);
  }

  commitResultIdempotent(task: QueuedJudgeTask): Promise<boolean> {
    const dedupKey = `${task.submissionId}:${task.runId}`;
    if (this.committedRuns.has(dedupKey)) {
      return Promise.resolve(false);
    }
    this.committedRuns.add(dedupKey);
    this.totalWritten++;
    return Promise.resolve(true);
  }

  snapshot(): Promise<RedisQueueSnapshot> {
    const pendingByTier = {
      high: this.pending.high.length,
      medium: this.pending.medium.length,
      low: this.pending.low.length,
    };
    const processingByTier = {
      high: this.processing.high.length,
      medium: this.processing.medium.length,
      low: this.processing.low.length,
    };
    const deadCount = this.dead.high.length + this.dead.medium.length +
      this.dead.low.length;
    return Promise.resolve({
      pendingByTier,
      processingByTier,
      waitingKeys: [...this.waitingKeys].sort(),
      deadCount,
      totalPending: pendingByTier.high + pendingByTier.medium +
        pendingByTier.low,
      totalProcessing: processingByTier.high + processingByTier.medium +
        processingByTier.low,
    });
  }

  resultStats(): Promise<{ uniqueCompleted: number; totalWritten: number }> {
    return Promise.resolve({
      uniqueCompleted: this.committedRuns.size,
      totalWritten: this.totalWritten,
    });
  }
}

function emptyTierCounts(): Record<QueuePriority, number> {
  return { high: 0, medium: 0, low: 0 };
}

function accumulateGroupStats(
  targetPending: Record<QueuePriority, number>,
  targetProcessing: Record<QueuePriority, number>,
  targetDead: Record<QueuePriority, number>,
  group: PoolQueueStats,
): void {
  for (const tier of ["high", "medium", "low"] as const) {
    targetPending[tier] += group.pendingByTier[tier];
    targetProcessing[tier] += group.processingByTier[tier];
    targetDead[tier] += group.deadByTier[tier];
  }
}

function formatPoolBreakdown(snap: RedisQueueSnapshot): string {
  if (!snap.byPool) return "";
  const parts = QUEUE_POOLS.map((pool) => {
    const stats = snap.byPool![pool];
    return `${pool}=${stats.totalPending}/${stats.totalProcessing}/${stats.deadCount}`;
  });
  if (snap.legacy) {
    parts.push(
      `legacy=${snap.legacy.totalPending}/${snap.legacy.totalProcessing}/${snap.legacy.deadCount}`,
    );
  }
  return ` pools(p/proc/dead)=[${parts.join(", ")}]`;
}

/** 轻量 RESP2 Redis TCP 客户端：用于在 live 模式下核对 Redis 分池/旧版队列及 `processing` / `waiting` / `dead` 真实状态。 */
export async function inspectLiveRedisQueue(
  redisUrl: string,
  prefix = "noj:judge:queue",
  queueLayout: QueueLayout = "both",
): Promise<RedisQueueSnapshot> {
  const parsed = new URL(redisUrl);
  const host = parsed.hostname || "127.0.0.1";
  const port = Number(parsed.port || "6379");
  const password = parsed.password ? decodeURIComponent(parsed.password) : "";
  const db = parsed.pathname && parsed.pathname.length > 1
    ? Number.parseInt(parsed.pathname.slice(1), 10)
    : 0;

  const conn = await Deno.connect({ hostname: host, port });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const encodeCmd = (...parts: string[]): Uint8Array => {
    const chunks = [`*${parts.length}\r\n`];
    for (const part of parts) {
      const bytes = encoder.encode(part);
      chunks.push(`$${bytes.length}\r\n${part}\r\n`);
    }
    return encoder.encode(chunks.join(""));
  };

  let buffer = "";
  const readLine = async (): Promise<string> => {
    while (true) {
      const idx = buffer.indexOf("\r\n");
      if (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        return line;
      }
      const chunk = new Uint8Array(4096);
      const n = await conn.read(chunk);
      if (n === null) throw new Error("Redis 连接意外关闭");
      buffer += decoder.decode(chunk.subarray(0, n));
    }
  };

  const readResp = async (): Promise<unknown> => {
    const line = await readLine();
    const prefixChar = line[0];
    const body = line.slice(1);
    if (prefixChar === "+") return body;
    if (prefixChar === ":") return Number.parseInt(body, 10);
    if (prefixChar === "-") throw new Error(`Redis 错误: ${body}`);
    if (prefixChar === "$") {
      const len = Number.parseInt(body, 10);
      if (len < 0) return null;
      while (buffer.length < len + 2) {
        const chunk = new Uint8Array(4096);
        const n = await conn.read(chunk);
        if (n === null) throw new Error("Redis 读取中断");
        buffer += decoder.decode(chunk.subarray(0, n));
      }
      const val = buffer.slice(0, len);
      buffer = buffer.slice(len + 2);
      return val;
    }
    if (prefixChar === "*") {
      const count = Number.parseInt(body, 10);
      if (count < 0) return [];
      const arr: unknown[] = [];
      for (let i = 0; i < count; i++) arr.push(await readResp());
      return arr;
    }
    throw new Error(`未知 RESP 响应: ${line}`);
  };

  const send = async (...parts: string[]): Promise<unknown> => {
    await conn.write(encodeCmd(...parts));
    return await readResp();
  };

  const inspectGroup = async (groupPrefix: string): Promise<PoolQueueStats> => {
    const pendingByTier = emptyTierCounts();
    const processingByTier = emptyTierCounts();
    const deadByTier = emptyTierCounts();
    for (const tier of ["high", "medium", "low"] as const) {
      pendingByTier[tier] = Number(
        await send("LLEN", `${groupPrefix}:${tier}`),
      );
      processingByTier[tier] = Number(
        await send("LLEN", `${groupPrefix}:${tier}:processing`),
      );
      deadByTier[tier] = Number(
        await send("LLEN", `${groupPrefix}:${tier}:dead`),
      );
    }
    return {
      pendingByTier,
      processingByTier,
      deadByTier,
      totalPending: pendingByTier.high + pendingByTier.medium +
        pendingByTier.low,
      totalProcessing: processingByTier.high + processingByTier.medium +
        processingByTier.low,
      deadCount: deadByTier.high + deadByTier.medium + deadByTier.low,
    };
  };

  try {
    if (password !== "") {
      await send("AUTH", password);
    }
    if (Number.isInteger(db) && db > 0) {
      await send("SELECT", String(db));
    }

    const pendingByTier = emptyTierCounts();
    const processingByTier = emptyTierCounts();
    const deadByTier = emptyTierCounts();

    let byPool: Record<QueuePool, PoolQueueStats> | undefined;
    if (queueLayout === "pools" || queueLayout === "both") {
      const poolEntries: Array<readonly [QueuePool, PoolQueueStats]> = [];
      for (const pool of QUEUE_POOLS) {
        poolEntries.push([pool, await inspectGroup(`${prefix}:${pool}`)]);
      }
      byPool = Object.fromEntries(poolEntries) as Record<
        QueuePool,
        PoolQueueStats
      >;
      for (const pool of QUEUE_POOLS) {
        accumulateGroupStats(
          pendingByTier,
          processingByTier,
          deadByTier,
          byPool[pool],
        );
      }
    }

    let legacy: PoolQueueStats | undefined;
    if (queueLayout === "legacy" || queueLayout === "both") {
      legacy = await inspectGroup(prefix);
      accumulateGroupStats(
        pendingByTier,
        processingByTier,
        deadByTier,
        legacy,
      );
    }

    const waitingRaw = await send("KEYS", `${prefix}:waiting:*`);
    const waitingKeys = Array.isArray(waitingRaw)
      ? waitingRaw.map((v) => String(v)).sort()
      : [];

    return {
      pendingByTier,
      processingByTier,
      deadByTier,
      waitingKeys,
      deadCount: deadByTier.high + deadByTier.medium + deadByTier.low,
      totalPending: pendingByTier.high + pendingByTier.medium +
        pendingByTier.low,
      totalProcessing: processingByTier.high + processingByTier.medium +
        processingByTier.low,
      queueLayout,
      ...(byPool ? { byPool } : {}),
      ...(legacy ? { legacy } : {}),
    };
  } finally {
    conn.close();
  }
}

/**
 * 执行混沌排空与中断重投一致性演练：
 * 1. 优雅排空阶段：验证在途任务清空而剩余任务留队；
 * 2. 强杀中断阶段：模拟 Worker 崩溃导致 `:processing` 滞留；
 * 3. 重投恢复阶段：Sweeper 重投并触发重复投递测试幂等性；
 * 4. 终态状态核对：pending=0、processing=0、waitingKeys=0、结果唯一无丢失。
 */
export async function runChaosDrainVerification(opts: {
  mode?: "dry-run" | "live";
  totalTasks?: number;
  inFlightBeforeDrain?: number;
  killInFlightCount?: number;
  redisUrl?: string;
  queuePrefix?: string;
  queueLayout?: QueueLayout;
  baselineDeadCount?: number;
  inspectRedis?: (
    redisUrl: string,
    prefix: string,
    queueLayout: QueueLayout,
  ) => Promise<RedisQueueSnapshot>;
  backend?: ChaosQueueBackend;
} = {}): Promise<ChaosVerifyResult> {
  const mode = opts.mode ?? "dry-run";
  const prefix = opts.queuePrefix ?? "noj:judge:queue";
  const queueLayout: QueueLayout = opts.queueLayout ?? "both";

  if (mode === "live") {
    if (!opts.redisUrl) {
      throw new Error("live 模式需要提供 --redis-url 或 REDIS_URL");
    }
    const inspect = opts.inspectRedis ?? inspectLiveRedisQueue;
    const snap = await inspect(opts.redisUrl, prefix, queueLayout);
    const baselineDead = opts.baselineDeadCount ?? 0;
    const queueDrained = snap.totalPending === 0 &&
      snap.totalProcessing === 0 &&
      snap.waitingKeys.length === 0;
    const deadClean = snap.deadCount <= baselineDead;
    const clean = queueDrained && deadClean;
    const poolBreakdown = formatPoolBreakdown(snap);
    return {
      mode: "live",
      passed: clean,
      totalSubmitted: 0,
      gracefulDrainChecked: true,
      requeuedCount: 0,
      duplicateDeliveriesInjected: 0,
      uniqueCompleted: 0,
      duplicateResults: 0,
      lostSubmissions: 0,
      finalSnapshot: snap,
      assertions: [
        {
          name: "redis_queue_drained",
          passed: queueDrained,
          detail:
            `layout=${queueLayout}, pending=${snap.totalPending}, processing=${snap.totalProcessing}, waiting=${snap.waitingKeys.length}${poolBreakdown}`,
        },
        {
          name: "redis_dead_queue_clean",
          passed: deadClean,
          detail:
            `dead=${snap.deadCount}, baseline=${baselineDead}${poolBreakdown}`,
        },
      ],
    };
  }

  const totalTasks = opts.totalTasks ?? 12;
  const inFlightBeforeDrain = Math.min(
    totalTasks,
    opts.inFlightBeforeDrain ?? 3,
  );
  const killCount = Math.min(
    totalTasks - inFlightBeforeDrain,
    opts.killInFlightCount ?? 4,
  );
  const backend = opts.backend ?? new InMemoryChaosBackend(prefix);
  const assertions: ChaosVerifyResult["assertions"] = [];

  const tiers: QueuePriority[] = ["high", "medium", "low"];
  for (let i = 0; i < totalTasks; i++) {
    await backend.enqueue({
      submissionId: `sub-chaos-${i + 1}`,
      runId: `run-chaos-${i + 1}`,
      attemptId: `att-chaos-${i + 1}`,
      priority: tiers[i % tiers.length]!,
      requeueCount: 0,
    });
  }

  // ---- 阶段 1：优雅排空（在途任务完成 ack，未领取任务留在主队列）----
  const pulledDrain: QueuedJudgeTask[] = [];
  for (let i = 0; i < inFlightBeforeDrain; i++) {
    for (const tier of tiers) {
      const task = await backend.pullToProcessing(tier);
      if (task !== null) {
        pulledDrain.push(task);
        break;
      }
    }
  }
  const midSnap = await backend.snapshot();
  assertions.push({
    name: "in_flight_tracked_in_processing_and_waiting",
    passed: midSnap.totalProcessing === pulledDrain.length &&
      midSnap.waitingKeys.length === pulledDrain.length,
    detail:
      `processing=${midSnap.totalProcessing}, waiting=${midSnap.waitingKeys.length}`,
  });

  // 排空收尾：仅处理已在途任务，不再拉取新任务
  for (const task of pulledDrain) {
    await backend.commitResultIdempotent(task);
    await backend.ackProcessing(task);
  }
  const drainedSnap = await backend.snapshot();
  assertions.push({
    name: "graceful_drain_clears_processing_keeps_pending",
    passed: drainedSnap.totalProcessing === 0 &&
      drainedSnap.waitingKeys.length === 0 &&
      drainedSnap.totalPending === totalTasks - pulledDrain.length,
    detail:
      `processing=${drainedSnap.totalProcessing}, pending=${drainedSnap.totalPending}`,
  });

  // ---- 阶段 2：模拟 Worker 强杀崩溃（任务进入 :processing 但未 ack）----
  const crashedTasks: QueuedJudgeTask[] = [];
  for (let i = 0; i < killCount; i++) {
    for (const tier of tiers) {
      const task = await backend.pullToProcessing(tier);
      if (task !== null) {
        crashedTasks.push(task);
        break;
      }
    }
  }
  // 模拟其中 1 个任务“已写结果但来不及 ack 就崩溃”，用于测试重投幂等性
  let duplicateDeliveriesInjected = 0;
  if (crashedTasks.length > 0) {
    await backend.commitResultIdempotent(crashedTasks[0]!);
    duplicateDeliveriesInjected = 1;
  }

  const crashSnap = await backend.snapshot();
  assertions.push({
    name: "crash_leaves_tasks_in_processing",
    passed: crashSnap.totalProcessing === crashedTasks.length,
    detail: `滞留 processing=${crashSnap.totalProcessing}`,
  });

  // ---- 阶段 3：Sweeper 重投恢复与全量消费 ----
  const requeuedCount = await backend.requeueStaleProcessing();
  assertions.push({
    name: "sweeper_requeues_all_stale_processing",
    passed: requeuedCount === crashedTasks.length,
    detail: `重投数量=${requeuedCount}`,
  });

  while (true) {
    let pulledAny = false;
    for (const tier of tiers) {
      const task = await backend.pullToProcessing(tier);
      if (task !== null) {
        pulledAny = true;
        await backend.commitResultIdempotent(task);
        await backend.ackProcessing(task);
      }
    }
    if (!pulledAny) break;
  }

  const finalSnapshot = await backend.snapshot();
  const resStats = await backend.resultStats();
  const duplicateResults = resStats.totalWritten - resStats.uniqueCompleted;
  const lostSubmissions = Math.max(0, totalTasks - resStats.uniqueCompleted);

  assertions.push({
    name: "final_queues_empty_and_idempotent",
    passed: finalSnapshot.totalPending === 0 &&
      finalSnapshot.totalProcessing === 0 &&
      finalSnapshot.waitingKeys.length === 0 &&
      finalSnapshot.deadCount === 0 &&
      resStats.uniqueCompleted === totalTasks &&
      duplicateResults === 0 &&
      lostSubmissions === 0,
    detail:
      `unique=${resStats.uniqueCompleted}/${totalTasks}, duplicates=${duplicateResults}, lost=${lostSubmissions}, dead=${finalSnapshot.deadCount}`,
  });

  return {
    mode: "dry-run",
    passed: assertions.every((a) => a.passed),
    totalSubmitted: totalTasks,
    gracefulDrainChecked: true,
    requeuedCount,
    duplicateDeliveriesInjected,
    uniqueCompleted: resStats.uniqueCompleted,
    duplicateResults,
    lostSubmissions,
    finalSnapshot,
    assertions,
  };
}

export function parseChaosArgs(args: readonly string[]): {
  mode: "dry-run" | "live";
  redisUrl?: string;
  queuePrefix: string;
  queueLayout: QueueLayout;
  totalTasks: number;
  baselineDeadCount: number;
  json: boolean;
  help: boolean;
} {
  let mode: "dry-run" | "live" = "dry-run";
  let redisUrl = Deno.env.get("REDIS_URL");
  let queuePrefix = "noj:judge:queue";
  let queueLayout: QueueLayout = "both";
  let totalTasks = 12;
  let baselineDeadCount = 0;
  let json = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--dry-run") mode = "dry-run";
    else if (arg === "--live") mode = "live";
    else if (arg === "--json") json = true;
    else if (arg === "--redis-url") redisUrl = args[++i];
    else if (arg === "--queue-prefix") queuePrefix = args[++i] ?? queuePrefix;
    else if (arg === "--queue-layout") {
      const val = args[++i];
      if (val !== "pools" && val !== "legacy" && val !== "both") {
        throw new Error(
          `--queue-layout 仅支持 pools | legacy | both，收到: ${val ?? ""}`,
        );
      }
      queueLayout = val;
    } else if (arg === "--tasks") {
      totalTasks = Number.parseInt(args[++i] ?? "12", 10);
    } else if (arg === "--baseline-dead-count") {
      baselineDeadCount = Number.parseInt(args[++i] ?? "0", 10);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return {
    mode,
    redisUrl,
    queuePrefix,
    queueLayout,
    totalTasks,
    baselineDeadCount,
    json,
    help,
  };
}

if (import.meta.main) {
  const opts = parseChaosArgs(Deno.args);
  if (opts.help) {
    console.log(
      [
        "用法: deno run -A stress/chaos-drain-verify.ts [选项]",
        "  --dry-run                         离线仿真优雅排空 + 崩溃重投幂等校验（默认）",
        "  --live                            连接真实 Redis 检查队列与 waiting/dead 状态清零",
        "  --redis-url <url>                 Redis 连接地址（live 模式使用）",
        "  --queue-prefix <pfx>              Redis 队列键前缀（默认 noj:judge:queue）",
        "  --queue-layout <pools|legacy|both> 队列布局扫描范围（默认 both）",
        "  --tasks <n>                       仿真注入任务数（默认 12）",
        "  --baseline-dead-count <n>         live 模式允许的死信队列基线数（默认 0）",
        "  --json                            输出 JSON 结果",
      ].join("\n"),
    );
    Deno.exit(0);
  }
  const result = await runChaosDrainVerification(opts);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[chaos-drain-verify] mode=${result.mode} passed=${result.passed} requeued=${result.requeuedCount} unique=${result.uniqueCompleted}/${result.totalSubmitted}`,
    );
    for (const a of result.assertions) {
      console.log(`  [${a.passed ? "PASS" : "FAIL"}] ${a.name}: ${a.detail}`);
    }
    if (result.finalSnapshot.byPool) {
      for (const pool of QUEUE_POOLS) {
        const s = result.finalSnapshot.byPool[pool];
        console.log(
          `  [pool:${pool}] pending=${s.totalPending} (H=${s.pendingByTier.high}/M=${s.pendingByTier.medium}/L=${s.pendingByTier.low}) processing=${s.totalProcessing} dead=${s.deadCount}`,
        );
      }
    }
  }
  if (!result.passed) Deno.exit(1);
}
