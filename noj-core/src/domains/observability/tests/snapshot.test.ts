import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import {
  getObservabilitySnapshot,
  renderPrometheusMetrics,
} from "../services/snapshot.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("snapshot: provider 失败时仍返回部分快照且 HTTP 可渲染", async () => {
  const r = createObservabilityRegistry();
  r.registerSnapshotProvider({
    name: "bad",
    collect: () => {
      throw new Error("boom");
    },
  });
  r.registerSnapshotProvider({
    name: "good",
    collect: () => ({
      queue: {
        pending: 1,
        processing: 0,
        result_pending: 0,
        result_processing: 0,
        judging: 0,
        oldest_judging_age_seconds: null,
      },
    }),
  });
  const snap = await getObservabilitySnapshot(r);
  assert(snap.queue.pending === 1, "good provider 应贡献数据");
  assert(
    snap.providers?.some((p) => p.status === "timeout"),
    "应有 timeout 状态",
  );
  const out = await renderPrometheusMetrics(r);
  assert(out.includes("noj_queue_pending_jobs"), "渲染应包含队列指标");
});
