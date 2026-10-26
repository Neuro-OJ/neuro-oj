/**
 * 维护/排空状态服务（P1d）。
 *
 * 为 `GET /api/v1/internal/drain/status` 计算「是否可安全排空」：
 * maintenance 已开启、Redis 可用、评测任务/结果队列已清空、没有在飞评测尝试、
 * 且已上报的 Judge Worker 没有活跃任务。
 *
 * 依赖注入设计：system 域**不得**直接 import submission / observability 域
 * （域边界门禁），因此 queue health 与 judge 心跳由组合根（app.ts）注入；
 * 缺省实现只提供保守降级值（永不误报 drained），生产路径必须注入真实实现。
 */

import { inArray, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { evaluationAttempts } from "../../../shared/db/schema.ts";
import type { QueueHealthResponse } from "../../submission/index.ts";
import { getSetting } from "./system-settings.ts";

/** 排空阻塞原因（稳定取值，供 CLI / 运维脚本与 noj-cli 判断）。 */
export type DrainBlocker =
  | "maintenance_off"
  | "redis_unavailable"
  | "judge_queue_pending"
  | "judge_queue_processing"
  | "result_queue_pending"
  | "result_queue_processing"
  | "attempts_in_flight"
  | "judge_workers_missing"
  | "judge_tasks_active";

/** 单个 Judge Worker 心跳报告（结构性兼容观测域 readJudgeNodeReports 的返回）。 */
export interface DrainJudgeNode {
  /** 实例标识（Redis 心跳 key 后缀）。 */
  instance_id: string;
  /** Judge Worker 版本号；旧版本心跳无该字段。 */
  judge_version?: string;
  /** 调度协议版本。 */
  scheduling_version?: number;
  /** 共享硬件资源组名。 */
  resource_group?: string;
  /** 当前活跃任务数。 */
  active_tasks: number;
  /** 最大并发任务数。 */
  max_concurrent_tasks: number;
  /** 心跳写入时间（毫秒时间戳）。 */
  updated_at_ms?: number;
}

/** computeDrainState 的纯函数输入。 */
export interface DrainStateInput {
  maintenance: boolean;
  queues: QueueHealthResponse;
  inFlightAttempts: number;
  judgeRequired: boolean;
  judgeNodes: DrainJudgeNode[];
}

/** computeDrainState 的纯函数输出。 */
export interface DrainState {
  maintenance: boolean;
  /** blockers 为空即已排空。 */
  drained: boolean;
  blockers: DrainBlocker[];
}

/** 排空状态接口的 `data` 结构。 */
export interface DrainStatusData {
  maintenance: boolean;
  drained: boolean;
  blockers: DrainBlocker[];
  /** 状态计算时间（ISO 8601）。 */
  checked_at: string;
  /** Redis 是否可用（与队列健康快照同口径）。 */
  redis_ok: boolean;
  /** 队列健康原样透传（getQueueHealth() 的返回，含 redis_ok）。 */
  queues: QueueHealthResponse;
  attempts: {
    /** state ∈ queued/judging 的评测尝试数。 */
    in_flight: number;
  };
  judge: {
    /** 与 emptyJudgeSnapshot 同口径：production 且 JUDGE_ENABLED != false。 */
    required: boolean;
    /** 上报心跳的 Judge Worker 数。 */
    reporting: number;
    nodes: DrainJudgeNode[];
  };
}

/** readDrainStatus 的可注入依赖集合（生产实现由 app.ts 组合根注入）。 */
export interface DrainStatusDeps {
  /** 读取维护模式开关（实时，不缓存）。 */
  getMaintenance(): boolean;
  /** 读取评测任务/结果队列健康（submission 域注入）。 */
  getQueueHealth(): Promise<QueueHealthResponse>;
  /** 统计 state ∈ queued/judging 的评测尝试数。 */
  countInFlightAttempts(): Promise<number>;
  /** 逐节点读取 Judge Worker 心跳（observability 域注入）。 */
  readJudgeNodeReports(): Promise<DrainJudgeNode[]>;
  /** judge 是否必需（观测域 emptyJudgeSnapshot 同口径）。 */
  judgeRequired(): boolean;
  /** 当前时间（ISO 8601）。 */
  now(): string;
}

/**
 * 计算排空状态（纯函数，便于单测）。
 *
 * 规则：
 * - `maintenance_off`：维护模式未开启（未进入排空流程）；
 * - `redis_unavailable`：Redis 不可用，队列长度不可信；
 * - 任务/结果队列的 pending / processing 任一非空都会阻塞；
 * - `attempts_in_flight`：仍有 queued/judging 的评测尝试；
 * - `judge_workers_missing`：judge 必需但没有任何 Worker 上报心跳；
 * - `judge_tasks_active`：任一 Worker 仍有活跃任务。
 *
 * dead（死信）队列只报告不阻塞：它们不会自动消费，排空时应保留供人工排查。
 *
 * @param input 排空判定输入
 * @returns 维护模式、是否已排空与阻塞原因
 */
export function computeDrainState(input: DrainStateInput): DrainState {
  const blockers: DrainBlocker[] = [];
  if (!input.maintenance) blockers.push("maintenance_off");
  if (!input.queues.redis_ok) blockers.push("redis_unavailable");
  if (input.queues.judge.queue_length > 0) blockers.push("judge_queue_pending");
  if (input.queues.judge.processing_length > 0) {
    blockers.push("judge_queue_processing");
  }
  if (input.queues.result.queue_length > 0) {
    blockers.push("result_queue_pending");
  }
  if (input.queues.result.processing_length > 0) {
    blockers.push("result_queue_processing");
  }
  if (input.inFlightAttempts > 0) blockers.push("attempts_in_flight");
  if (input.judgeRequired && input.judgeNodes.length === 0) {
    blockers.push("judge_workers_missing");
  }
  if (input.judgeNodes.some((node) => node.active_tasks > 0)) {
    blockers.push("judge_tasks_active");
  }
  return {
    maintenance: input.maintenance,
    drained: blockers.length === 0,
    blockers,
  };
}

/** 缺省依赖：保守降级值，保证「未注入真实实现时永不误报已排空」。 */
const FALLBACK_DRAIN_STATUS_DEPS: DrainStatusDeps = {
  getMaintenance: () => getSetting("maintenance_mode")?.value === true,
  getQueueHealth: () => {
    const unavailable = {
      queue_length: -1,
      processing_length: -1,
      dead_length: -1,
    };
    return Promise.resolve({
      judge: unavailable,
      result: unavailable,
      redis_ok: false,
    });
  },
  countInFlightAttempts: async () => {
    const [row] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(evaluationAttempts)
      .where(inArray(evaluationAttempts.state, ["queued", "judging"]));
    return Number(row?.count ?? 0);
  },
  readJudgeNodeReports: () => Promise.resolve([]),
  // 与 emptyJudgeSnapshot 同口径；生产必须由组合根注入观测域实现。
  judgeRequired: () =>
    Deno.env.get("NOJ_ENV") === "production" &&
    Deno.env.get("JUDGE_ENABLED") !== "false",
  now: () => new Date().toISOString(),
};

/**
 * 读取完整排空状态。
 *
 * @param deps 依赖覆盖（测试注入；生产由 app.ts 注入队列/心跳实现）
 * @returns 排空状态接口 data
 */
export async function readDrainStatus(
  deps: Partial<DrainStatusDeps> = {},
): Promise<DrainStatusData> {
  const resolved: DrainStatusDeps = { ...FALLBACK_DRAIN_STATUS_DEPS, ...deps };
  const maintenance = resolved.getMaintenance();
  const judgeRequired = resolved.judgeRequired();
  const [queues, inFlightAttempts, nodes] = await Promise.all([
    resolved.getQueueHealth(),
    resolved.countInFlightAttempts(),
    resolved.readJudgeNodeReports(),
  ]);
  const state = computeDrainState({
    maintenance,
    queues,
    inFlightAttempts,
    judgeRequired,
    judgeNodes: nodes,
  });
  return {
    ...state,
    checked_at: resolved.now(),
    redis_ok: queues.redis_ok,
    queues,
    attempts: { in_flight: inFlightAttempts },
    judge: {
      required: judgeRequired,
      reporting: nodes.length,
      nodes,
    },
  };
}
