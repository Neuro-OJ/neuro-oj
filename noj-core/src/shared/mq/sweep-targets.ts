/**
 * 消费队列的 sweeper 覆盖登记表。
 *
 * 背景（2026-09-12 架构评审 §2.5）：`BRPOPLPUSH` 语义下，消息在"已取走、未 ACK"
 * 窗口内因进程被杀 / Redis 中断而残留在 `:processing`。sweeper 的队列清单此前是
 * **硬编码**的（三级评测队列 + 结果队列），于是后来新增的消费者
 * （`noj:search:index`、`noj:review:dm`）没有兜底：消息永久滞留，搜索索引静默落后。
 *
 * 这里把"哪些队列需要 sweeper 兜底"从硬编码清单改为**登记制**：
 * `createConsumer` 创建时自动登记，sweeper 遍历登记表。**新增消费者自动获得兜底**，
 * 不再依赖"记得去改 sweeper 里的数组"。
 */

export interface SweepTarget {
  /** 主队列名（`:processing` 由基类约定拼接） */
  queueName: string;
  /** 超过该时长仍未确认即视为卡住并重投 */
  processingTimeoutMs: number;
}

const targets = new Map<string, SweepTarget>();

/**
 * 登记一个需要 sweeper 兜底的队列（由 createConsumer 自动调用，业务代码无需手动登记）。
 *
 * 同一队列可能有多个并发消费者实例（如 `RESULT_CONSUMER_CONCURRENCY=4`），
 * 取最小的超时值，避免后创建的实例放宽兜底时限。
 */
export function registerSweepTarget(target: SweepTarget): void {
  const existing = targets.get(target.queueName);
  if (!existing || target.processingTimeoutMs < existing.processingTimeoutMs) {
    targets.set(target.queueName, target);
  }
}

/** 当前已登记的兜底目标（供 sweeper 遍历）。 */
export function listSweepTargets(): SweepTarget[] {
  return [...targets.values()];
}

/** 测试用：清空登记表。 */
export function _resetSweepTargetsForTest(): void {
  targets.clear();
}
