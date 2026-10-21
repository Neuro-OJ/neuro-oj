/** runtime 后台任务观测 provider；只读取通用任务表，不依赖任何业务 handler。 */
import type { ObservabilityRegistry } from "../../shared/observability/contracts.ts";
import { readTaskHealth } from "./tasks/repository.ts";

export function registerRuntimeObservability(
  registry: ObservabilityRegistry,
): void {
  registry.registerSnapshotProvider({
    name: "runtime.background_tasks",
    timeoutMs: 500,
    collect: async () => {
      const health = await readTaskHealth();
      return {
        background_tasks: {
          ready: health.ready,
          leased: health.leased,
          failed: health.failed,
          oldest_ready_age_seconds: health.oldestReadyAgeMs / 1000,
          oldest_leased_age_seconds: health.oldestLeasedAgeMs / 1000,
          next_lease_expiry_seconds: health.nextLeaseExpiryMs / 1000,
        },
      };
    },
  });
}
