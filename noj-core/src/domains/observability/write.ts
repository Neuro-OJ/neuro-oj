/**
 * 观测域写侧门面。
 *
 * 业务域只能 import 本文件，不能碰观测域内部实现。
 */

import { observability } from "../../shared/observability/registry.ts";
export { observability };
export type {
  HealthProbe,
  MetricDefinition,
  SnapshotProvider,
} from "../../shared/observability/contracts.ts";

export function registerBusinessMetric(
  def: Parameters<typeof observability.registerBusinessMetric>[0],
): void {
  observability.registerBusinessMetric(def);
}

export function registerHealthProbe(
  probe: Parameters<typeof observability.registerHealthProbe>[0],
): void {
  observability.registerHealthProbe(probe);
}

export function registerSnapshotProvider(
  provider: Parameters<typeof observability.registerSnapshotProvider>[0],
): void {
  observability.registerSnapshotProvider(provider);
}
