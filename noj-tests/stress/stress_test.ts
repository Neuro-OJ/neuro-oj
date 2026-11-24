/**
 * 压测指标计算、公平性断言与混沌排空恢复校验单元测试。
 *
 * 零外部容器依赖：可经由 `Deno.test` 或直接 `deno run -A stress/stress_test.ts` 执行。
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  computeLoadStats,
  evaluateLoadThresholds,
  percentile,
  runContestLoadTest,
  type SubmissionRecord,
} from "./contest-load-test.ts";
import { runChaosDrainVerification } from "./chaos-drain-verify.ts";

const CASES: Array<{ name: string; fn: () => Promise<void> | void }> = [
  {
    name: "percentile: 准确计算 P50 / P95 / P99 与边界值",
    fn: () => {
      assertEquals(percentile([], 95), 0);
      assertEquals(percentile([42], 99), 42);
      const samples = Array.from({ length: 100 }, (_, i) => i + 1);
      assertEquals(percentile(samples, 50), 50.5);
      assertEquals(percentile(samples, 95), 95.05);
      assertEquals(percentile(samples, 99), 99.01);
    },
  },
  {
    name:
      "computeLoadStats 与 evaluateLoadThresholds: 统计吞吐、背压与阈值告警",
    fn: () => {
      const records: SubmissionRecord[] = [
        {
          index: 0,
          userId: "u1",
          problemKind: "ai",
          priority: "high",
          submitHttpMs: 5,
          queueWaitMs: 10,
          e2eLatencyMs: 100,
          completedAtMs: 100,
          httpStatus: 201,
          outcome: "ok",
        },
        {
          index: 1,
          userId: "u2",
          problemKind: "oi",
          priority: "medium",
          submitHttpMs: 5,
          queueWaitMs: 25,
          e2eLatencyMs: 200,
          completedAtMs: 200,
          httpStatus: 201,
          outcome: "ok",
        },
        {
          index: 2,
          userId: "u3",
          problemKind: "ai",
          priority: "low",
          submitHttpMs: 5,
          queueWaitMs: 60,
          e2eLatencyMs: 400,
          completedAtMs: 400,
          httpStatus: 201,
          outcome: "ok",
        },
        {
          index: 3,
          userId: "u4",
          problemKind: "oi",
          priority: "high",
          submitHttpMs: 3,
          queueWaitMs: 0,
          e2eLatencyMs: 3,
          completedAtMs: 10,
          httpStatus: 503,
          outcome: "backpressure",
        },
      ];

      const stats = computeLoadStats(records, 1000, 0.95);
      assertEquals(stats.totalSubmissions, 4);
      assertEquals(stats.succeeded, 3);
      assertEquals(stats.failed, 1);
      assertEquals(stats.errorRate, 0.25);
      assertEquals(stats.backpressure503, 1);
      assertEquals(stats.throughputPerSec, 3);
      assertEquals(stats.e2eLatencyMs.p50, 200);
      assert(stats.e2eLatencyMs.p95 > 350);
      assertEquals(stats.byProblemKind.ai.total, 2);
      assertEquals(stats.byProblemKind.oi.total, 2);

      // 超过错误率阈值 0.05，应触发拦截
      const evalFail = evaluateLoadThresholds(stats, {
        maxErrorRate: 0.05,
        maxP95Ms: 500,
        maxP99Ms: 1000,
        minLowCompletionRate: 0.95,
      });
      assertEquals(evalFail.passed, false);
      assert(evalFail.violations.some((v) => v.includes("错误率")));
      assert(evalFail.warnings.some((w) => w.includes("503")));
    },
  },
  {
    name: "contest-load-test --dry-run: 混合 AI/OI 与 4:2:1 优先级全链路通过",
    fn: async () => {
      const report = await runContestLoadTest({
        mode: "dry-run",
        users: 30,
        peakSubmissions: 70,
        aiRatio: 0.6,
        burstWindowMs: 0,
        mockProfile: {
          workerSlots: 4,
          aiBaseJudgeMs: 30,
          oiBaseJudgeMs: 15,
        },
      });

      assertEquals(
        report.evaluation.passed,
        true,
        report.evaluation.violations.join("; "),
      );
      assertEquals(report.stats.totalSubmissions, 70);
      assertEquals(report.stats.succeeded, 70);
      assertEquals(report.stats.byProblemKind.ai.total, 42);
      assertEquals(report.stats.byProblemKind.oi.total, 28);
      assertEquals(report.stats.priorityFairness.lowStarved, false);
      assertEquals(report.stats.priorityFairness.fairnessPassed, true);
      assert(
        report.stats.byPriority.high.queueWaitMs.avg <=
          report.stats.byPriority.low.queueWaitMs.avg,
        "4:2:1 调度下 high 平均排队延迟应不高于 low",
      );
    },
  },
  {
    name: "contest-load-test --dry-run: 触发 429/503 背压与异常阈值告警",
    fn: async () => {
      const report = await runContestLoadTest({
        mode: "dry-run",
        users: 20,
        peakSubmissions: 40,
        burstWindowMs: 0,
        mockProfile: {
          workerSlots: 2,
          backpressureQueueLimit: 15,
          rateLimitBurstThreshold: 30,
        },
      });

      assert(report.stats.backpressure503 > 0, "应观测到 503 队列背压");
      assert(report.stats.rateLimited429 > 0, "应观测到 429 限流");
      assertEquals(report.evaluation.passed, false);
      assert(report.evaluation.warnings.some((w) => w.includes("429")));
      assert(report.evaluation.warnings.some((w) => w.includes("503")));
    },
  },
  {
    name: "chaos-drain-verify --dry-run: 优雅排空与中断重投幂等恢复全链路通过",
    fn: async () => {
      const result = await runChaosDrainVerification({
        mode: "dry-run",
        totalTasks: 15,
        inFlightBeforeDrain: 4,
        killInFlightCount: 5,
      });

      assertEquals(result.passed, true);
      assertEquals(result.gracefulDrainChecked, true);
      assertEquals(result.requeuedCount, 5);
      assertEquals(result.duplicateDeliveriesInjected, 1);
      assertEquals(result.uniqueCompleted, 15);
      assertEquals(result.duplicateResults, 0);
      assertEquals(result.lostSubmissions, 0);
      assertEquals(result.finalSnapshot.totalPending, 0);
      assertEquals(result.finalSnapshot.totalProcessing, 0);
      assertEquals(result.finalSnapshot.waitingKeys.length, 0);
    },
  },
];

for (const tc of CASES) {
  Deno.test(tc.name, tc.fn);
}

if (import.meta.main) {
  let failed = 0;
  for (const tc of CASES) {
    try {
      await tc.fn();
      console.log(`PASS: ${tc.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL: ${tc.name}\n`, err);
    }
  }
  console.log(
    `\n[stress_test] ${CASES.length - failed}/${CASES.length} passed`,
  );
  if (failed > 0) Deno.exit(1);
}
