/**
 * submission 域观测 provider 注册。
 *
 * 由 app.ts 组合根调用；观测域不 import 本域。
 */

import type { ObservabilityRegistry } from "../../shared/observability/contracts.ts";
import { getQueueHealth } from "./services/queue.ts";
import { consumerAlive } from "./mq/consumer.ts";

export function registerSubmissionObservability(
  registry: ObservabilityRegistry,
): void {
  registry.registerSnapshotProvider({
    name: "submission.queue",
    timeoutMs: 500,
    collect: async () => {
      const q = await getQueueHealth();
      return {
        queue: {
          pending: q.judge.queue_length,
          processing: q.judge.processing_length,
          result_pending: q.result.queue_length,
          result_processing: q.result.processing_length,
          judging: null,
          oldest_judging_age_seconds: null,
        },
        dependencies: {
          result_consumer: { status: consumerAlive.value ? "up" : "down" },
        },
      };
    },
  });
}
