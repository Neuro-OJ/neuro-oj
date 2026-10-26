import { logger } from "../../../shared/base/logging.ts";
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

/** 生命周期只保存停止句柄，业务领取、重试和游标均在数据库，多副本可并行运行。 */
export function startEducationWorker(options: {
  sendEmail?: Parameters<typeof processEducationEmailBatch>[1];
} = {}) {
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
  const done = Promise.all([progress, email]).then(() => undefined);
  return { stop: () => controller.abort(), done };
}
