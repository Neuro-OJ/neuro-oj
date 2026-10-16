import type { DomainQueryScope } from "../../query/index.ts";
import type { JudgeQueuePool } from "../../../shared/mq/judge-queues.ts";

/** 实例队列按查看者的实时域权限过滤明细，全局数字另行统计。 */
export interface QueueQueryScope extends DomainQueryScope {
  instance?: boolean;
  viewerId?: string;
  platformAdmin?: boolean;
}

/** 队列中的一个条目（pending / judging / recently_completed 共用）。 */
export interface QueueItem {
  id: string;
  problem_id: string;
  problem_title: string;
  language: string;
  submitted_at: string;
  submitted_by: string;
  domain_id?: string;
  domain_slug?: string;
  /** 条目类型：正式提交或自测。 */
  kind: "submission" | "self_test";
  resource_pool?: JudgeQueuePool;
  waiting_reason?: "pool_full" | "user_busy" | "memory";
  /** 仅 judging 和 completed 项有值。 */
  judge_started_at?: string | null;
  /** 仅 completed 项有值。 */
  judge_finished_at?: string | null;
  /** 仅 completed 项有值。 */
  status?: string;
  /** 仅 completed 项有值（×100 整数值）。 */
  score?: number | null;
}

/** 队列统计信息。 */
export interface QueueStats {
  pending_count: number;
  judging_count: number;
  completed_today: number;
  pools?: Record<
    JudgeQueuePool,
    {
      pending: number;
      processing: number;
      active?: number;
      compiling?: number;
      running?: number;
      task_capacity?: number;
      run_capacity?: number;
    }
  >;
  resource_memory?: { reserved_mb: number; budget_mb: number };
}

/** 队列概览接口响应。 */
export interface QueueResponse {
  pending: QueueItem[];
  judging: QueueItem[];
  recently_completed: QueueItem[];
  stats: QueueStats;
  scope?: "domain" | "instance";
  visible_counts?: {
    pending: number;
    judging: number;
    completed_today: number;
  };
}

/** 单条评测队列的健康快照。 */
export interface QueueHealthEntry {
  /** 主队列当前长度（待 worker 领取）。 */
  queue_length: number;
  /** processing 列表当前长度（已领取但未确认）。 */
  processing_length: number;
  /** dead 死信队列当前长度。 */
  dead_length: number;
}

/** 平台队列健康接口响应。 */
export interface QueueHealthResponse {
  pools?: Record<JudgeQueuePool, QueueHealthEntry>;
  resource_groups?: Record<string, Record<string, unknown>>;
  /** 评测任务队列（noj-core → noj-judge）。 */
  judge: QueueHealthEntry;
  /** 评测结果队列（noj-judge → noj-core）。 */
  result: QueueHealthEntry;
  /** Redis 是否可用；不可用时各队列长度降级为 -1。 */
  redis_ok: boolean;
}
