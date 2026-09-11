/**
 * 业务指标注册入口。
 *
 * 业务域通过 write.ts 的 registerBusinessMetric 注册自己的指标；
 * 本文件保留为 catalog 的集中说明与校验入口。
 */

import type { MetricDefinition } from "../../../shared/observability/contracts.ts";
import { observability } from "../write.ts";

export function registerBusinessMetric(def: MetricDefinition): void {
  observability.registerBusinessMetric(def);
}
