/**
 * 评测任务队列命名（core 与 judge 的唯一事实源）。
 *
 * noj-judge 读取 `JUDGE_QUEUE` 作为前缀并派生 `{prefix}:high|:medium|:low`；
 * noj-core 必须使用同一前缀，否则任务会静默积压且没有任何告警。
 * 生产环境请让 core 与 judge 共用同一个 `.env`（见 `.env.prod.example`）。
 */

/** 评测任务优先级（与 submission 域的 JudgeTaskPriority 结构一致）。 */
export type JudgeQueuePriority = "high" | "medium" | "low";
export const JUDGE_RESOURCE_POOLS = ["oi-wasm", "oi-native", "ai"] as const;
export type JudgeQueuePool = typeof JUDGE_RESOURCE_POOLS[number];
/** 仅用于滚动升级期间维持旧 Worker；生产新部署默认使用分池队列。 */
export const JUDGE_QUEUE_LAYOUT =
  Deno.env.get("JUDGE_QUEUE_LAYOUT") === "legacy" ? "legacy" : "pools";

/** 评测任务队列名前缀，默认 `noj:judge:queue`。 */
export const JUDGE_QUEUE_PREFIX: string = Deno.env.get("JUDGE_QUEUE")?.trim() ||
  "noj:judge:queue";

/**
 * 依据前缀构造三级队列名（纯函数，便于单测）。
 *
 * @param prefix - 队列名前缀，须与 noj-judge 的 `JUDGE_QUEUE` 一致
 */
export function buildJudgeQueues(
  prefix: string,
): Record<JudgeQueuePriority, string> {
  return {
    high: `${prefix}:high`,
    medium: `${prefix}:medium`,
    low: `${prefix}:low`,
  };
}

/** 三级评测任务队列名映射。 */
export const LEGACY_PRIORITY_QUEUES: Record<JudgeQueuePriority, string> =
  buildJudgeQueues(JUDGE_QUEUE_PREFIX);

export const JUDGE_POOL_QUEUES = Object.fromEntries(
  JUDGE_RESOURCE_POOLS.map((pool) => [
    pool,
    buildJudgeQueues(`${JUDGE_QUEUE_PREFIX}:${pool}`),
  ]),
) as Record<JudgeQueuePool, Record<JudgeQueuePriority, string>>;

/** 历史导出供 AI 兼容调用；通用消费者必须使用 ALL_JUDGE_QUEUES。 */
export const JUDGE_QUEUES = JUDGE_QUEUE_LAYOUT === "legacy"
  ? LEGACY_PRIORITY_QUEUES
  : JUDGE_POOL_QUEUES.ai;

/** 消费者、sweeper 和监控共用完整队列集合，避免新增队列遗漏恢复路径。 */
export const ALL_JUDGE_QUEUES = JUDGE_QUEUE_LAYOUT === "legacy"
  ? Object.values(JUDGE_QUEUES)
  : JUDGE_RESOURCE_POOLS.flatMap((pool) =>
    Object.values(JUDGE_POOL_QUEUES[pool])
  );

export function judgeQueueFor(
  pool: JudgeQueuePool,
  priority: JudgeQueuePriority,
): string {
  return JUDGE_QUEUE_LAYOUT === "legacy"
    ? JUDGE_QUEUES[priority]
    : JUDGE_POOL_QUEUES[pool][priority];
}

/** 升级前的单队列名（仅用于一次性迁移，见 legacy-judge-queue.ts）。 */
export const LEGACY_JUDGE_QUEUE: string = JUDGE_QUEUE_PREFIX;
