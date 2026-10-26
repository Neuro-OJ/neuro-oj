import { logger } from "../../../shared/base/logging.ts";
import type { ManagedTask } from "../../../shared/runtime/managed-task.ts";
import { publishDueAssignments } from "./assignment-lifecycle.ts";
import { processEducationBatch } from "./progress-worker.ts";
import { processEducationEmailBatch } from "./notification-email.ts";

async function waitForTick(signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const cancel = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, 1500);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** 当前教学 worker（单例；stop 后到 done 完成期间仍保留，防止重叠启动）。 */
let _educationTask: ManagedTask | null = null;

/** 生命周期只保存停止句柄，业务领取、重试和游标均在数据库，多副本可并行运行。 */
export function startEducationWorker(options: {
  sendEmail?: Parameters<typeof processEducationEmailBatch>[1];
} = {}): ManagedTask {
  // 单例语义：运行期间（含 stop 后、done 尚未完成）重复调用返回同一实例，
  // 避免关闭过程中又起一条循环；done 完成后释放，下一次调用才是真正重启。
  if (_educationTask !== null) return _educationTask;
  const controller = new AbortController();
  const progress = (async () => {
    while (!controller.signal.aborted) {
      try {
        await publishDueAssignments();
        const batch = await processEducationBatch();
        if (batch.length) continue;
      } catch (error) {
        logger.warn("教学后台任务失败，将从持久记录重试", {
          error_type: error instanceof Error ? error.name : "Error",
        });
      }
      await waitForTick(controller.signal);
    }
  })();
  const email = (async () => {
    while (!controller.signal.aborted) {
      try {
        const batch = await processEducationEmailBatch(20, options.sendEmail);
        if (batch.length) continue;
      } catch (error) {
        logger.warn("教学邮件后台任务失败，将从持久记录重试", {
          error_type: error instanceof Error ? error.name : "Error",
        });
      }
      await waitForTick(controller.signal);
    }
  })();
  // 两条循环都必须结束才 resolve done；任一异常也要等另一条退出后再汇总抛出，
  // 避免 Promise.all 的 early reject 让 done 提前完成、另一条循环仍在写库。
  const done = Promise.allSettled([progress, email]).then((results) => {
    const failures = results
      .filter((result): result is PromiseRejectedResult =>
        result.status === "rejected"
      )
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "教学后台循环异常结束");
    }
  });
  const task: ManagedTask = {
    name: "education-worker",
    stop: () => controller.abort(),
    done,
  };
  _educationTask = task;
  void done.then(
    () => {
      if (_educationTask === task) _educationTask = null;
    },
    () => {
      if (_educationTask === task) _educationTask = null;
    },
  );
  return task;
}

/** 测试用：停止当前单例（不会打断正在写库的那一轮，仍需 await done）。 */
export function _resetEducationWorkerForTest(): void {
  // 只 stop；done 完成后的清理回调才释放单例，避免在途循环与新实例重叠。
  _educationTask?.stop();
}
