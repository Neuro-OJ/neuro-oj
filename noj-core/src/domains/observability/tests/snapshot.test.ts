import { createObservabilityRegistry } from "../../../shared/observability/registry.ts";
import { registerPlatformMetrics } from "../metrics/platform.ts";
import {
  collectMetricsSnapshot,
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
    collect: () =>
      Promise.resolve({
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
  const snap = await collectMetricsSnapshot(r);
  assert(snap.queue.pending === 1, "good provider 应贡献数据");
  assert(
    snap.providers?.some((p) => p.status === "error"),
    "应有 error 状态",
  );
  const out = await renderPrometheusMetrics(r);
  assert(out.includes("noj_queue_pending_jobs"), "渲染应包含队列指标");
});

Deno.test("snapshot: db/redis 探针合并进 dependencies 且 /metrics 无重复 HELP", async () => {
  const r = createObservabilityRegistry();
  registerPlatformMetrics(r);
  r.registerHealthProbe({
    name: "database",
    critical: true,
    check: () => ({ status: "up" as const }),
  });
  r.registerHealthProbe({
    name: "redis",
    critical: true,
    check: () => ({ status: "up" as const }),
  });
  r.registerSnapshotProvider({
    name: "submission.queue",
    collect: () =>
      Promise.resolve({
        queue: {
          pending: 2,
          processing: 0,
          result_pending: 0,
          result_processing: 0,
          judging: 0,
          oldest_judging_age_seconds: 1,
        },
        dependencies: { result_consumer: { status: "up" } },
      }),
  });

  const snap = await collectMetricsSnapshot(r);
  assert(snap.dependencies.database, "dependencies 应包含 database");
  assert(snap.dependencies.redis, "dependencies 应包含 redis");
  assert(
    (snap.dependencies.database as { status?: string }).status === "up",
    "database 应为 up",
  );
  assert(
    (snap.dependencies.result_consumer as { status?: string }).status === "up",
    "result_consumer 应为 up",
  );

  const out = await renderPrometheusMetrics(r);
  const helpCounts = new Map<string, number>();
  for (const line of out.split("\n")) {
    const m = /^# HELP (\S+)/.exec(line);
    if (m?.[1]) helpCounts.set(m[1], (helpCounts.get(m[1]) ?? 0) + 1);
  }
  for (const [name, count] of helpCounts) {
    assert(count === 1, `metric family ${name} 应只有一份 HELP，实际 ${count}`);
  }
  assert(out.includes("noj_database_up 1"), "database_up 应为 1");
  assert(out.includes("noj_redis_up 1"), "redis_up 应为 1");
  assert(out.includes("noj_result_consumer_up 1"), "result_consumer_up 应为 1");
  assert(out.includes("noj_judge_workers 0"), "judge_workers 应降级为 0");
});

Deno.test("snapshot: 不再上报派生的错误率与平均延迟指标", async () => {
  const r = createObservabilityRegistry();
  registerPlatformMetrics(r);
  const out = await renderPrometheusMetrics(r);
  assert(
    !out.includes("noj_api_error_rate_percent"),
    "派生的错误率指标应已移除（判定归 Prometheus 规则）",
  );
  assert(
    !out.includes("noj_api_average_latency_ms"),
    "派生的平均延迟指标应已移除（判定归 Prometheus 规则）",
  );
  assert(
    out.includes("noj_http_request_errors_total"),
    "原始错误计数 counter 必须保留",
  );
  assert(
    out.includes("noj_http_request_duration_seconds"),
    "原始延迟 histogram 必须保留",
  );
});
