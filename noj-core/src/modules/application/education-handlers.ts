/** 教学后台任务处理器（P4）。
 *
 * application 只负责把通用任务控制语义接到 education 的业务适配器；教学
 * outbox、分页游标和通知投递事实仍由 education 持有，runtime 不反向导入业务。
 */
import type {
  ClaimedTask,
  TaskHandler,
  TaskRescheduleResult,
} from "../runtime/tasks/contracts.ts";
import { processEducationBackgroundTask } from "../education/index.ts";

export const handleEducationTask: TaskHandler = async (
  task: ClaimedTask,
  signal,
) => {
  const outboxId = task.payload.outbox_id;
  if (typeof outboxId !== "string" || outboxId.length === 0) {
    throw new TypeError("教学任务缺少 outbox_id");
  }
  const outcome = await processEducationBackgroundTask(outboxId, signal);
  if (outcome.processed) {
    return {
      ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
      outbox_id: outboxId,
    };
  }
  if (!outcome.nextAvailableAt || !outcome.outboxPayload) {
    throw new Error("教学任务未完成但缺少可恢复游标");
  }
  const result: TaskRescheduleResult = {
    __task_control: "reschedule",
    availableAt: outcome.nextAvailableAt,
    payload: {
      ...task.payload,
      education_cursor: outcome.outboxPayload._education_cursor ?? null,
    },
  };
  return result;
};
