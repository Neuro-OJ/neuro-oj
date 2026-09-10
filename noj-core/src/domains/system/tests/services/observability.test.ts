import { createObservabilityRegistry } from "../../../../shared/observability/registry.ts";
import { registerSystemEmailMetrics } from "../../observability.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("system observability: 邮件指标注册后可写入", () => {
  const r = createObservabilityRegistry();
  registerSystemEmailMetrics(r);
  r.inc("noj_email_send_attempts_total", {
    provider: "mock",
    message_type: "password_reset",
  });
  r.inc("noj_email_delivery_events_total", {
    provider: "mock",
    event_type: "permanent_bounce",
  });
  assert(
    r.sum("noj_email_send_attempts_total") === 1,
    "邮件发送尝试应记录 1 次",
  );
  assert(
    r.sum("noj_email_delivery_events_total") === 1,
    "邮件送达事件应记录 1 次",
  );
});
