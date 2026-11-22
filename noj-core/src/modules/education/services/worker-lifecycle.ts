import { logger } from "../../../shared/base/logging.ts";
import type { ManagedTask } from "../../../shared/runtime/managed-task.ts";
import { publishDueAssignments } from "./assignment-lifecycle.ts";
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

/** 邮件投递使用自己的业务状态表（单例；stop 后到 done 完成期间仍保留）。 */
let _educationEmailTask: ManagedTask | null = null;

/**
 * 启动教学邮件投递循环。
 *
 * 这是通知副作用的独立周期任务，教学事实本身由 background task worker
 * 处理。邮件不承诺 exactly-once，数据库状态与权限复核保证重试安全。
 */
export function startEducationEmailWorker(options: {
  sendEmail?: Parameters<typeof processEducationEmailBatch>[1];
} = {}): ManagedTask {
  if (_educationEmailTask !== null) return _educationEmailTask;
  const controller = new AbortController();
  const loop = (async () => {
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
  const task: ManagedTask = {
    name: "education-email-worker",
    stop: () => controller.abort(),
    done: loop,
  };
  _educationEmailTask = task;
  void task.done.then(
    () => {
      if (_educationEmailTask === task) _educationEmailTask = null;
    },
    () => {
      if (_educationEmailTask === task) _educationEmailTask = null;
    },
  );
  return task;
}

/** 到期发布是 assignment 生命周期扫描，独立于教学事件任务。 */
let _educationPublishingTask: ManagedTask | null = null;

export function startEducationPublishingWorker(): ManagedTask {
  if (_educationPublishingTask !== null) return _educationPublishingTask;
  const controller = new AbortController();
  const loop = (async () => {
    while (!controller.signal.aborted) {
      try {
        const batch = await publishDueAssignments();
        if (batch.length) continue;
      } catch (error) {
        logger.warn("教学预约发布失败，将从持久状态重试", {
          error_type: error instanceof Error ? error.name : "Error",
        });
      }
      await waitForTick(controller.signal);
    }
  })();
  const task: ManagedTask = {
    name: "education-publishing-worker",
    stop: () => controller.abort(),
    done: loop,
  };
  _educationPublishingTask = task;
  void task.done.then(
    () => {
      if (_educationPublishingTask === task) _educationPublishingTask = null;
    },
    () => {
      if (_educationPublishingTask === task) _educationPublishingTask = null;
    },
  );
  return task;
}
