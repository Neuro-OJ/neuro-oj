import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import { collectSnapshot, runHealthProbes } from "../probes/registry.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("probes: 探针超时返回 unknown 且不抛错", async () => {
  const r = createObservabilityRegistry();
  r.registerHealthProbe({
    name: "slow",
    critical: true,
    timeoutMs: 10,
    check: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ status: "up" }), 100)
      ),
  });
  const results = await runHealthProbes(r, { timeoutMs: 20 });
  assert(results[0]!.status === "unknown", "超时应为 unknown");
});

Deno.test("probes: provider 失败返回部分快照", async () => {
  const r = createObservabilityRegistry();
  r.registerSnapshotProvider({
    name: "bad",
    timeoutMs: 10,
    collect: () => {
      throw new Error("boom");
    },
  });
  r.registerSnapshotProvider({
    name: "good",
    timeoutMs: 10,
    collect: () => ({ queue: { pending: 1 } }),
  });
  const snap = await collectSnapshot(r, { timeoutMs: 20 });
  assert(
    (snap as { queue?: { pending?: number } }).queue?.pending === 1,
    "good provider 应贡献数据",
  );
});
