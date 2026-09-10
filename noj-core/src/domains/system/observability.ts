/**
 * system 域业务指标注册。
 *
 * 邮件指标由 system 域拥有；app.ts 组合根在启动时注册，
 * 保证首次写指标前定义已存在。
 */

import type { ObservabilityRegistry } from "../../shared/observability/contracts.ts";

export function registerSystemEmailMetrics(
  registry: ObservabilityRegistry,
): void {
  registry.registerBusinessMetric({
    name: "noj_email_send_attempts_total",
    help: "邮件发送尝试总数",
    type: "counter",
    owner: "system",
    labels: ["provider", "message_type"],
  });
  registry.registerBusinessMetric({
    name: "noj_email_delivery_events_total",
    help: "邮件送达事件总数",
    type: "counter",
    owner: "system",
    labels: ["provider", "event_type"],
  });
  registry.registerBusinessMetric({
    name: "noj_email_delivery_events_duplicate_total",
    help: "重复邮件送达事件总数",
    type: "counter",
    owner: "system",
    labels: ["provider"],
  });
  registry.registerBusinessMetric({
    name: "noj_email_temporary_failures_total",
    help: "邮件临时失败总数",
    type: "counter",
    owner: "system",
    labels: ["provider"],
  });
  registry.registerBusinessMetric({
    name: "noj_email_suppressions_total",
    help: "邮件永久抑制总数",
    type: "counter",
    owner: "system",
    labels: ["provider", "reason"],
  });
}
