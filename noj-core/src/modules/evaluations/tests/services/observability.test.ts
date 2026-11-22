import { createObservabilityRegistry } from "../../../../shared/observability/registry.ts";
import { registerSubmissionObservability } from "../../observability.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("submission observability: 注册 provider 后可聚合队列", () => {
  const r = createObservabilityRegistry();
  registerSubmissionObservability(r);
  const names = r.listSnapshotProviders().map((p) => p.name);
  assert(
    names.includes("submission.queue"),
    "应注册 submission.queue provider",
  );
});

Deno.test("submission observability: result_consumer 是 critical readiness 探针", () => {
  const r = createObservabilityRegistry();
  registerSubmissionObservability(r);
  const probe = r.listHealthProbes().find((p) => p.name === "result_consumer");
  assert(probe, "应注册 result_consumer 探针");
  assert(probe!.critical === true, "result_consumer 应为 critical");
});
