/**
 * 后台任务处理器注册表（P4）。
 *
 * runtime worker 只认识 `TaskHandlerMap`；具体处理器由 application 组装注入，
 * 因此 runtime 不会反向依赖业务模块（`runtime-business-dependency`）。
 *
 * 启动时缺任何已登记任务类型的 handler 都必须显式失败——静默跳过会让任务
 * 永远停在 pending，形成"看起来在跑、实际不处理"的假绿。
 */
import type { TaskHandlerMap, TaskType } from "../runtime/tasks/contracts.ts";
import { TASK_TYPES } from "../runtime/tasks/contracts.ts";
import { handleSearchIndexTask } from "./search-handlers.ts";
import { handleEvaluationDispatchTask } from "./dispatch-handlers.ts";

/**
 * 组装生产 handler 表。
 *
 * 尚未接入的处理器必须显式实现为"记失败"，不能返回成功——否则任务会被标记
 * 完成而事实没有生效。
 */
export function createBackgroundHandlers(): TaskHandlerMap {
  const handlers: Record<
    TaskType,
    (task: never, signal: AbortSignal) => Promise<
      Record<string, unknown> | void
    >
  > = {
    "search.index": (task) =>
      handleSearchIndexTask(
        task as Parameters<typeof handleSearchIndexTask>[0],
      ),
    "evaluation.dispatch": (task) =>
      handleEvaluationDispatchTask(
        task as Parameters<typeof handleEvaluationDispatchTask>[0],
      ),
    // 教学重算由 education 模块的 worker 负责（P4 后续批次接入）。
    "education.recompute": () =>
      Promise.reject(new Error("education.recompute 处理器尚未接入")),
    // 对象回收在 application 组合层实现（引用守卫 + 域计数释放）。
    "storage.reclaim": () =>
      Promise.reject(new Error("storage.reclaim 处理器尚未接入")),
    // 邮件通知允许重复风险，由 application 注入真实发送实现后启用。
    "notification.email": () =>
      Promise.reject(new Error("notification.email 处理器尚未接入")),
  };
  return handlers as unknown as TaskHandlerMap;
}

/** 校验 handler 表覆盖全部任务类型；返回缺失类型列表。 */
export function missingTaskHandlers(
  handlers: Partial<Record<TaskType, unknown>>,
): TaskType[] {
  return TASK_TYPES.filter((taskType) =>
    typeof handlers[taskType] !== "function"
  );
}
