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
