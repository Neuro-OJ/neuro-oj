/**
 * 压测指标计算、公平性断言与混沌排空恢复校验单元测试。
 *
 * 零外部容器依赖：可经由 `Deno.test` 或直接 `deno run -A stress/stress_test.ts` 执行。
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  computeLoadStats,
  evaluateLoadThresholds,
  parseLoadTestArgs,
  percentile,
  runContestLoadTest,
  type SubmissionRecord,
} from "./contest-load-test.ts";
import {
  inspectLiveRedisQueue,
  parseChaosArgs,
  runChaosDrainVerification,
} from "./chaos-drain-verify.ts";
import { createAuthRequestRunner } from "./contest-load-auth.ts";
import { resolveSubmissionQueueWaitMs } from "./contest-load-live.ts";

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

      // 12/500 = 0.024 不能因提前 round2 成 0.02 而误放行 maxErrorRate: 0.02
      const precisionRecords: SubmissionRecord[] = Array.from(
        { length: 500 },
        (_, i) => ({
          index: i,
          userId: `u-${i % 10}`,
          problemKind: i % 2 === 0 ? "ai" : "oi",
          priority: "high",
          submitHttpMs: 5,
          queueWaitMs: 10,
          e2eLatencyMs: 50,
          completedAtMs: 50,
          httpStatus: i < 12 ? 500 : 201,
          outcome: i < 12 ? "error" : "ok",
        }),
      );
      const precisionStats = computeLoadStats(precisionRecords, 1000, 0.95);
      assertEquals(precisionStats.errorRate, 0.024);
      const precisionEval = evaluateLoadThresholds(precisionStats, {
        maxErrorRate: 0.02,
        maxP95Ms: 500,
        maxP99Ms: 1000,
        minLowCompletionRate: 0.95,
      });
      assertEquals(precisionEval.passed, false);
      assert(
        precisionEval.violations.some((v) => v.includes("2.40%")),
        `期望错误率展示为 2.40%，实际: ${precisionEval.violations.join("; ")}`,
      );
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
  {
    name: "chaos-drain-verify --live: 死信队列非零时门禁失败，基线无新增可通过",
    fn: async () => {
      const deadSnap = {
        pendingByTier: { high: 0, medium: 0, low: 0 },
        processingByTier: { high: 0, medium: 0, low: 0 },
        waitingKeys: [],
        deadCount: 2,
        totalPending: 0,
        totalProcessing: 0,
      };
      const cleanSnap = { ...deadSnap, deadCount: 0 };

      // 死信队列非零（默认基线 0）必须失败
      const failedByDead = await runChaosDrainVerification({
        mode: "live",
        redisUrl: "redis://127.0.0.1:6379",
        inspectRedis: () => Promise.resolve(deadSnap),
      });
      assertEquals(failedByDead.passed, false);
      assertEquals(
        failedByDead.assertions.find((a) => a.name === "redis_dead_queue_clean")
          ?.passed,
        false,
      );

      // 相对捕获基线无新增死信时可通过；有新增死信时仍失败
      const passedWithBaseline = await runChaosDrainVerification({
        mode: "live",
        redisUrl: "redis://127.0.0.1:6379",
        baselineDeadCount: 2,
        inspectRedis: () => Promise.resolve(deadSnap),
      });
      assertEquals(passedWithBaseline.passed, true);

      const failedWithNewDead = await runChaosDrainVerification({
        mode: "live",
        redisUrl: "redis://127.0.0.1:6379",
        baselineDeadCount: 1,
        inspectRedis: () => Promise.resolve(deadSnap),
      });
      assertEquals(failedWithNewDead.passed, false);

      const passedClean = await runChaosDrainVerification({
        mode: "live",
        redisUrl: "redis://127.0.0.1:6379",
        inspectRedis: () => Promise.resolve(cleanSnap),
      });
      assertEquals(passedClean.passed, true);
    },
  },
  {
    name:
      "contest-load-test --live: 走真实域提交契约、自动解析 version_id 并触发重测 low 队列",
    fn: async () => {
      const calls: Array<{
        method: string;
        path: string;
        auth?: string;
        body?: unknown;
      }> = [];
      let subSeq = 0;
      let jobSeq = 0;

      const fakeFetch: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const auth = new Headers(init?.headers).get("Authorization") ??
          undefined;
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined;
        calls.push({ method, path: url.pathname, auth, body });

        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/problems/P101"
        ) {
          return Promise.resolve(Response.json({ version_id: "ver-ai-101" }));
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/problems/P102"
        ) {
          return Promise.resolve(Response.json({ version_id: "ver-oi-102" }));
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/contests/c-live"
        ) {
          return Promise.resolve(
            Response.json({ data: { status: "running" } }),
          );
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/contests/c-live/problems"
        ) {
          return Promise.resolve(Response.json({
            data: [
              { label: "A", display_id: "P101" },
              { label: "B", display_id: "P102" },
            ],
          }));
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school"
        ) {
          return Promise.resolve(
            Response.json({ data: { is_member: true } }),
          );
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/school/contests/c-live/register"
        ) {
          return Promise.resolve(
            Response.json({ message: "竞赛注册成功" }, { status: 201 }),
          );
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/submissions"
        ) {
          return Promise.resolve(Response.json({ data: [] }));
        }
        if (
          method === "POST" &&
          (url.pathname === "/api/v1/domains/school/submissions" ||
            /^\/api\/v1\/domains\/school\/contests\/c-live\/problems\/[AB]\/submissions$/
              .test(url.pathname))
        ) {
          assert(typeof body.problem_ref === "string");
          assert(
            body.version_id === "ver-ai-101" ||
              body.version_id === "ver-oi-102",
          );
          assert(typeof body.language === "string");
          if (body.version_id === "ver-oi-102") {
            assertEquals(body.language, "cc");
          } else {
            assertEquals(body.language, "python3");
          }
          assert(typeof body.code === "string");
          return Promise.resolve(
            Response.json(
              { data: { id: `sub-${++subSeq}` } },
              { status: 201 },
            ),
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/school/submissions/sub-")
        ) {
          return Promise.resolve(Response.json({
            data: {
              status: "finished",
              judge_started_at: new Date().toISOString(),
            },
          }));
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/school/submission-jobs"
        ) {
          assertEquals(body.kind, "rejudge");
          assertEquals(body.scope.type, "selected");
          assertEquals(body.target.mode, "submitted");
          return Promise.resolve(
            Response.json(
              { data: { job_id: `job-${++jobSeq}`, status: "queued" } },
              { status: 202 },
            ),
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/school/submission-jobs/job-")
        ) {
          return Promise.resolve(Response.json({
            data: { status: "completed", counts: { succeeded: 1 } },
          }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      };

      const report = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        adminToken: "jwt-test",
        userTokens: ["jwt-u0", "jwt-u1", "jwt-u2"],
        domainSlug: "school",
        contestId: "c-live",
        aiProblemId: "P101",
        oiProblemId: "P102",
        users: 3,
        peakSubmissions: 7,
        aiRatio: 0.5,
        burstWindowMs: 0,
        pollIntervalMs: 1,
        fetchFn: fakeFetch,
      });

      assertEquals(
        report.evaluation.passed,
        true,
        report.evaluation.violations.join("; "),
      );
      assertEquals(report.stats.totalSubmissions, 7);
      assertEquals(report.stats.succeeded, 7);
      assertEquals(report.stats.byPriority.high.total, 4);
      assertEquals(report.stats.byPriority.medium.total, 2);
      assertEquals(report.stats.byPriority.low.total, 1);
      assertEquals(report.stats.byPriority.low.succeeded, 1);
      const submitAuths = new Set(
        calls
          .filter((c) => c.method === "POST" && c.path.endsWith("/submissions"))
          .map((c) => c.auth),
      );
      assertEquals(
        submitAuths,
        new Set(["Bearer jwt-u0", "Bearer jwt-u1", "Bearer jwt-u2"]),
      );
      const rejudgeCall = calls.find((c) =>
        c.method === "POST" &&
        c.path === "/api/v1/domains/school/submission-jobs"
      );
      assert(rejudgeCall, "low 档任务必须走真实重测接口");
      assertEquals(rejudgeCall.auth, "Bearer jwt-test");
    },
  },
  {
    name:
      "contest-load-test --live: 无竞赛时按 medium 统计且重测无权限(403)时 low 不得虚假通过",
    fn: async () => {
      const fakeFetch: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/main/submissions"
        ) {
          return Promise.resolve(Response.json({
            data: [{ id: "seed-sub-1", status: "finished" }],
          }));
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/main/submissions"
        ) {
          return Promise.resolve(
            Response.json({ data: { id: "sub-new-1" } }, { status: 201 }),
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/main/submissions/")
        ) {
          return Promise.resolve(Response.json({
            data: {
              status: "finished",
              judge_started_at: new Date().toISOString(),
            },
          }));
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/main/submission-jobs"
        ) {
          return Promise.resolve(new Response("forbidden", { status: 403 }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      };

      const report = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        adminToken: "jwt-test",
        userTokens: ["jwt-u0", "jwt-u1"],
        aiProblemId: "P1",
        oiProblemId: "P2",
        versionId: "ver-explicit",
        users: 2,
        peakSubmissions: 7,
        burstWindowMs: 0,
        pollIntervalMs: 1,
        fetchFn: fakeFetch,
      });

      // 未传 contestId：原本 plan 中的 high 提交在服务端实际进入 medium 队列
      assertEquals(report.stats.byPriority.high.total, 0);
      assertEquals(report.stats.byPriority.medium.total, 6);
      // 重测接口 403：low 队列不得虚假宣称通过
      assertEquals(report.stats.byPriority.low.total, 1);
      assertEquals(report.stats.byPriority.low.succeeded, 0);
      assertEquals(report.stats.priorityFairness.lowStarved, true);
      assertEquals(report.evaluation.passed, false);
    },
  },
  {
    name: "contest-load-test --live: 无可用重测目标时不回退普通提交并明确失败",
    fn: async () => {
      let submittedNormal = false;
      const fakeFetch: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/main/submissions"
        ) {
          return Promise.resolve(Response.json({ data: [] }));
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/main/submissions"
        ) {
          submittedNormal = true;
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      };

      const report = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        adminToken: "jwt-test",
        aiProblemId: "P1",
        oiProblemId: "P2",
        versionId: "ver-explicit",
        priorityMix: { high: 0, medium: 0, low: 1 },
        users: 1,
        peakSubmissions: 1,
        burstWindowMs: 0,
        pollIntervalMs: 1,
        fetchFn: fakeFetch,
      });

      assertEquals(submittedNormal, false);
      assertEquals(report.stats.byPriority.low.total, 1);
      assertEquals(report.stats.byPriority.low.succeeded, 0);
      assertEquals(report.stats.priorityFairness.lowStarved, true);
      assertEquals(report.evaluation.passed, false);
    },
  },
  {
    name:
      "contest-load-test --live: --auto-register 通过公开注册与管理员开号获取多用户独立 Bearer Token",
    fn: async () => {
      // 场景 1：仅传 --auto-register，走公开注册 -> 邮箱验证 -> 登录
      const verified = new Set<string>();
      const registeredUsers = new Map<string, string>();
      const submitAuthsPublic = new Set<string>();
      let seq = 0;

      const publicFetch: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined;
        const auth = new Headers(init?.headers).get("Authorization") ?? "";

        if (method === "POST" && url.pathname === "/api/v1/auth/register") {
          registeredUsers.set(body.username, body.password);
          return Promise.resolve(Response.json({
            data: {
              id: `id-${body.username}`,
              username: body.username,
              email_verification_token: `verify-${body.username}`,
            },
          }, { status: 201 }));
        }
        if (method === "POST" && url.pathname === "/api/v1/auth/email/verify") {
          const username = String(body.token).replace(/^verify-/, "");
          verified.add(username);
          return Promise.resolve(Response.json({ data: { verified: true } }));
        }
        if (method === "POST" && url.pathname === "/api/v1/auth/login") {
          assert(verified.has(body.login), "必须先完成邮箱验证再登录");
          return Promise.resolve(Response.json({
            data: {
              token: `pub-tok-${body.login}`,
              user: { must_change_password: false },
            },
          }));
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/main/submissions"
        ) {
          submitAuthsPublic.add(auth);
          return Promise.resolve(
            Response.json({ data: { id: `sub-${++seq}` } }, { status: 201 }),
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/main/submissions/sub-")
        ) {
          return Promise.resolve(Response.json({
            data: {
              status: "finished",
              judge_started_at: new Date().toISOString(),
            },
          }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      };

      const pubReport = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        autoRegister: true,
        aiProblemId: "P1",
        oiProblemId: "P2",
        versionId: "v1",
        priorityMix: { high: 0, medium: 1, low: 0 },
        users: 3,
        peakSubmissions: 6,
        burstWindowMs: 0,
        pollIntervalMs: 1,
        fetchFn: publicFetch,
      });
      assertEquals(pubReport.stats.succeeded, 6);
      assertEquals(submitAuthsPublic.size, 3);

      // 场景 2：公开注册 403 关闭时，自动回退管理员批量开号 + 登录 + 强制改密
      const submitAuthsAdminFallback = new Set<string>();
      const adminFetch: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined;
        const auth = new Headers(init?.headers).get("Authorization") ?? "";

        if (method === "POST" && url.pathname === "/api/v1/auth/register") {
          return Promise.resolve(
            Response.json({ code: "REGISTER_DISABLED" }, { status: 403 }),
          );
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/admin/identity/users/import"
        ) {
          assertEquals(auth, "Bearer jwt-admin");
          const created = (body.users as Array<{
            username: string;
            email: string;
            password: string;
          }>).map((u, i) => ({
            id: `u-${i}`,
            username: u.username,
            email: u.email,
            password: u.password,
          }));
          return Promise.resolve(
            Response.json({ data: created }, { status: 201 }),
          );
        }
        if (method === "POST" && url.pathname === "/api/v1/auth/login") {
          return Promise.resolve(Response.json({
            data: {
              token: `temp-${body.login}`,
              user: { must_change_password: true },
            },
          }));
        }
        if (
          method === "POST" && url.pathname === "/api/v1/auth/change-password"
        ) {
          assert(auth.startsWith("Bearer temp-"));
          const uname = auth.replace(/^Bearer temp-/, "");
          return Promise.resolve(Response.json({
            data: { token: `clean-${uname}` },
          }));
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/main/submissions"
        ) {
          assert(auth.startsWith("Bearer clean-"));
          submitAuthsAdminFallback.add(auth);
          return Promise.resolve(
            Response.json({ data: { id: `sub-${++seq}` } }, { status: 201 }),
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/main/submissions/sub-")
        ) {
          return Promise.resolve(Response.json({
            data: {
              status: "finished",
              judge_started_at: new Date().toISOString(),
            },
          }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      };

      const admReport = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        adminToken: "jwt-admin",
        aiProblemId: "P1",
        oiProblemId: "P2",
        versionId: "v1",
        priorityMix: { high: 0, medium: 1, low: 0 },
        users: 3,
        peakSubmissions: 6,
        burstWindowMs: 0,
        pollIntervalMs: 1,
        fetchFn: adminFetch,
      });
      assertEquals(admReport.stats.succeeded, 6);
      assertEquals(submitAuthsAdminFallback.size, 3);
    },
  },
  {
    name:
      "contest-load-test --live: 缺少独立凭据且未启用 --allow-shared-user 时拒绝假多用户并发",
    fn: async () => {
      const denyAllProvisionFetch: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (method === "POST" && url.pathname === "/api/v1/auth/register") {
          return Promise.resolve(new Response("disabled", { status: 403 }));
        }
        if (
          method === "POST" &&
          url.pathname.startsWith("/api/v1/admin/identity/users")
        ) {
          return Promise.resolve(new Response("forbidden", { status: 403 }));
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/main/submissions"
        ) {
          return Promise.resolve(
            Response.json({ data: { id: "sub-shared" } }, { status: 201 }),
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/main/submissions/")
        ) {
          return Promise.resolve(Response.json({
            data: {
              status: "finished",
              judge_started_at: new Date().toISOString(),
            },
          }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      };

      // 未显式允许共享单账号且无法获取独立账号时必须报错
      await assertRejects(
        () =>
          runContestLoadTest({
            mode: "live",
            baseUrl: "http://mock.local",
            adminToken: "jwt-admin",
            aiProblemId: "P1",
            oiProblemId: "P2",
            versionId: "v1",
            priorityMix: { high: 0, medium: 1, low: 0 },
            users: 3,
            peakSubmissions: 3,
            burstWindowMs: 0,
            pollIntervalMs: 1,
            fetchFn: denyAllProvisionFetch,
          }),
        Error,
      );

      // 显式提供的 userTokens 数量少于 users 且未允许共享时同样报错
      await assertRejects(
        () =>
          runContestLoadTest({
            mode: "live",
            baseUrl: "http://mock.local",
            userTokens: ["only-one"],
            aiProblemId: "P1",
            oiProblemId: "P2",
            versionId: "v1",
            priorityMix: { high: 0, medium: 1, low: 0 },
            users: 3,
            peakSubmissions: 3,
            burstWindowMs: 0,
            pollIntervalMs: 1,
            fetchFn: denyAllProvisionFetch,
          }),
        Error,
      );

      // 显式传入 allowSharedUser: true 后放行
      const sharedReport = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        adminToken: "jwt-admin",
        allowSharedUser: true,
        aiProblemId: "P1",
        oiProblemId: "P2",
        versionId: "v1",
        priorityMix: { high: 0, medium: 1, low: 0 },
        users: 3,
        peakSubmissions: 3,
        burstWindowMs: 0,
        pollIntervalMs: 1,
        fetchFn: denyAllProvisionFetch,
      });
      assertEquals(sharedReport.stats.succeeded, 3);
    },
  },
  {
    name:
      "contest-load-test --live: 支持 --user-credentials-file（token 与 login/password）",
    fn: async () => {
      const credFile = await Deno.makeTempFile({ suffix: ".json" });
      try {
        await Deno.writeTextFile(
          credFile,
          JSON.stringify([
            { token: "file-tok-0" },
            { login: "user_one", password: "Password123!" },
          ]),
        );
        const submitAuths = new Set<string>();
        let seq = 0;
        const fakeFetch: typeof fetch = (input, init) => {
          const url = new URL(String(input));
          const method = init?.method ?? "GET";
          const auth = new Headers(init?.headers).get("Authorization") ?? "";
          if (method === "POST" && url.pathname === "/api/v1/auth/login") {
            return Promise.resolve(Response.json({
              data: {
                token: "login-tok-1",
                user: { must_change_password: false },
              },
            }));
          }
          if (
            method === "POST" &&
            url.pathname === "/api/v1/domains/main/submissions"
          ) {
            submitAuths.add(auth);
            return Promise.resolve(
              Response.json({ data: { id: `sub-${++seq}` } }, { status: 201 }),
            );
          }
          if (
            method === "GET" &&
            url.pathname.startsWith("/api/v1/domains/main/submissions/sub-")
          ) {
            return Promise.resolve(Response.json({
              data: {
                status: "finished",
                judge_started_at: new Date().toISOString(),
              },
            }));
          }
          return Promise.resolve(new Response("not found", { status: 404 }));
        };

        const report = await runContestLoadTest({
          mode: "live",
          baseUrl: "http://mock.local",
          userCredentialsFile: credFile,
          aiProblemId: "P1",
          oiProblemId: "P2",
          versionId: "v1",
          priorityMix: { high: 0, medium: 1, low: 0 },
          users: 2,
          peakSubmissions: 4,
          burstWindowMs: 0,
          pollIntervalMs: 1,
          fetchFn: fakeFetch,
        });
        assertEquals(report.stats.succeeded, 4);
        assertEquals(
          submitAuths,
          new Set(["Bearer file-tok-0", "Bearer login-tok-1"]),
        );
      } finally {
        await Deno.remove(credFile);
      }
    },
  },
  {
    name:
      "contest-load-test --live: 解耦突发 POST 与慢轮询，peakSubmissions > users 时突发 POST 仍在 burstWindowMs 内发出",
    fn: async () => {
      const burstWindowMs = 80;
      const simulatedJudgeMs = 200;
      const postArrivals: Array<{ elapsedMs: number; auth: string }> = [];
      const createdAt = new Map<string, number>();
      let seq = 0;
      let testStart = 0;

      const fakeFetch: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const auth = new Headers(init?.headers).get("Authorization") ?? "";
        if (testStart === 0) testStart = performance.now();

        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/main/contests/c-burst/register"
        ) {
          return Promise.resolve(
            Response.json({ message: "竞赛注册成功" }, { status: 201 }),
          );
        }
        if (
          method === "POST" &&
          (url.pathname === "/api/v1/domains/main/submissions" ||
            /^\/api\/v1\/domains\/main\/contests\/c-burst\/problems\/[AB]\/submissions$/
              .test(url.pathname))
        ) {
          const id = `sub-burst-${++seq}`;
          const now = performance.now();
          createdAt.set(id, now);
          postArrivals.push({ elapsedMs: now - testStart, auth });
          return Promise.resolve(
            Response.json({ data: { id } }, { status: 201 }),
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/main/submissions/sub-burst-")
        ) {
          const id = url.pathname.split("/").pop()!;
          const started = createdAt.get(id) ?? performance.now();
          const done = performance.now() - started >= simulatedJudgeMs;
          return Promise.resolve(Response.json({
            data: done
              ? {
                status: "finished",
                judge_started_at: new Date().toISOString(),
              }
              : { status: "judging", judge_started_at: null },
          }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      };

      const report = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        userTokens: ["tok-u0", "tok-u1"],
        contestId: "c-burst",
        aiProblemId: "P1",
        oiProblemId: "P2",
        versionId: "v1",
        priorityMix: { high: 0.5, medium: 0.5, low: 0 },
        users: 2,
        peakSubmissions: 8,
        burstWindowMs,
        pollIntervalMs: 15,
        timeoutMs: 5000,
        fetchFn: fakeFetch,
      });

      assertEquals(report.stats.totalSubmissions, 8);
      assertEquals(report.stats.succeeded, 8);
      assertEquals(postArrivals.length, 8);

      // 若未解耦，users=2 且 peakSubmissions=8 在 200ms 慢评测下至少需 3*200=600ms 才能发完 POST；
      // 解耦后全部 8 次 POST 应在 burstWindowMs 窗口附近（远小于单次 200ms 评测耗时）完成发出。
      const maxPostElapsed = Math.max(...postArrivals.map((p) => p.elapsedMs));
      assert(
        maxPostElapsed < simulatedJudgeMs,
        `突发 POST 被慢轮询阻塞: maxPostElapsed=${
          maxPostElapsed.toFixed(1)
        }ms >= simulatedJudgeMs=${simulatedJudgeMs}ms`,
      );
      assert(
        maxPostElapsed <= burstWindowMs + 60,
        `突发 POST 超出 burstWindowMs 窗口过多: maxPostElapsed=${
          maxPostElapsed.toFixed(1)
        }ms`,
      );

      // 两个虚拟用户各自携带独立 Bearer Token
      const authCounts = new Map<string, number>();
      for (const p of postArrivals) {
        authCounts.set(p.auth, (authCounts.get(p.auth) ?? 0) + 1);
      }
      assertEquals(authCounts.get("Bearer tok-u0"), 4);
      assertEquals(authCounts.get("Bearer tok-u1"), 4);
      assert(
        report.stats.e2eLatencyMs.min >= simulatedJudgeMs - 20,
        `端到端延迟应真实包含异步轮询等待: min=${report.stats.e2eLatencyMs.min}ms`,
      );
    },
  },
  {
    name:
      "chaos-drain-verify --live: 扫描全部分资源池队列并在单池残留(pending/processing/dead)时精准判为失败",
    fn: async () => {
      const parseRespCommands = (
        input: string,
      ): { commands: string[][]; rest: string } => {
        const commands: string[][] = [];
        let buf = input;
        while (buf.length > 0) {
          if (!buf.startsWith("*")) break;
          const firstCr = buf.indexOf("\r\n");
          if (firstCr < 0) break;
          const argc = Number.parseInt(buf.slice(1, firstCr), 10);
          let pos = firstCr + 2;
          const parts: string[] = [];
          let complete = true;
          for (let i = 0; i < argc; i++) {
            if (buf[pos] !== "$") {
              complete = false;
              break;
            }
            const lenCr = buf.indexOf("\r\n", pos);
            if (lenCr < 0) {
              complete = false;
              break;
            }
            const len = Number.parseInt(buf.slice(pos + 1, lenCr), 10);
            const valStart = lenCr + 2;
            const valEnd = valStart + len;
            if (buf.length < valEnd + 2) {
              complete = false;
              break;
            }
            parts.push(buf.slice(valStart, valEnd));
            pos = valEnd + 2;
          }
          if (!complete) break;
          commands.push(parts);
          buf = buf.slice(pos);
        }
        return { commands, rest: buf };
      };

      const withMockRedis = async (
        listLens: Record<string, number>,
        waitingKeys: string[],
        fn: (redisUrl: string) => Promise<void>,
      ) => {
        const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
        const addr = listener.addr as Deno.NetAddr;
        const conns = new Set<Deno.Conn>();
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        const loop = (async () => {
          for await (const conn of listener) {
            conns.add(conn);
            (async () => {
              let buf = "";
              const chunk = new Uint8Array(4096);
              try {
                while (true) {
                  const n = await conn.read(chunk);
                  if (n === null) break;
                  buf += decoder.decode(chunk.subarray(0, n));
                  const parsed = parseRespCommands(buf);
                  buf = parsed.rest;
                  for (const cmd of parsed.commands) {
                    const op = (cmd[0] ?? "").toUpperCase();
                    if (op === "LLEN") {
                      const count = listLens[cmd[1] ?? ""] ?? 0;
                      await conn.write(encoder.encode(`:${count}\r\n`));
                    } else if (op === "KEYS") {
                      const pat = cmd[1] ?? "";
                      const prefix = pat.endsWith("*") ? pat.slice(0, -1) : pat;
                      const matched = waitingKeys.filter((k) =>
                        k.startsWith(prefix)
                      );
                      const resp = [
                        `*${matched.length}\r\n`,
                        ...matched.map((k) => `$${k.length}\r\n${k}\r\n`),
                      ].join("");
                      await conn.write(encoder.encode(resp));
                    } else {
                      await conn.write(encoder.encode("+OK\r\n"));
                    }
                  }
                }
              } catch {
                // 连接关闭忽略
              } finally {
                conns.delete(conn);
                try {
                  conn.close();
                } catch {
                  // ignore
                }
              }
            })();
          }
        })();

        try {
          await fn(`redis://127.0.0.1:${addr.port}/0`);
        } finally {
          listener.close();
          for (const c of conns) {
            try {
              c.close();
            } catch {
              // ignore
            }
          }
          await loop.catch(() => {});
        }
      };

      // 1) 仅 ai:high 有 pending 残留
      await withMockRedis(
        { "noj:judge:queue:ai:high": 2 },
        [],
        async (redisUrl) => {
          const snap = await inspectLiveRedisQueue(
            redisUrl,
            "noj:judge:queue",
            "pools",
          );
          assertEquals(snap.totalPending, 2);
          assertEquals(snap.byPool?.ai.pendingByTier.high, 2);
          assertEquals(snap.byPool?.["oi-native"].totalPending, 0);

          const res = await runChaosDrainVerification({
            mode: "live",
            redisUrl,
            queueLayout: "pools",
          });
          assertEquals(res.passed, false);
          assertEquals(
            res.assertions.find((a) => a.name === "redis_queue_drained")
              ?.passed,
            false,
          );
        },
      );

      // 2) 仅 oi-native:medium:dead 有死信残留
      await withMockRedis(
        { "noj:judge:queue:oi-native:medium:dead": 1 },
        [],
        async (redisUrl) => {
          const res = await runChaosDrainVerification({
            mode: "live",
            redisUrl,
            queueLayout: "both",
          });
          assertEquals(res.passed, false);
          assertEquals(res.finalSnapshot.deadCount, 1);
          assertEquals(
            res.finalSnapshot.byPool?.["oi-native"].deadByTier.medium,
            1,
          );
          assertEquals(
            res.assertions.find((a) => a.name === "redis_dead_queue_clean")
              ?.passed,
            false,
          );
        },
      );

      // 3) 仅 oi-native:low:processing 有在途残留
      await withMockRedis(
        { "noj:judge:queue:oi-native:low:processing": 3 },
        [],
        async (redisUrl) => {
          const res = await runChaosDrainVerification({
            mode: "live",
            redisUrl,
            queueLayout: "both",
          });
          assertEquals(res.passed, false);
          assertEquals(res.finalSnapshot.totalProcessing, 3);
          assertEquals(
            res.finalSnapshot.byPool?.["oi-native"].processingByTier.low,
            3,
          );
          assertEquals(
            res.assertions.find((a) => a.name === "redis_queue_drained")
              ?.passed,
            false,
          );
        },
      );

      // 4) legacy 残留只在 legacy/both 布局下捕获，pools 布局不误报；全清零时通过
      await withMockRedis(
        { "noj:judge:queue:high": 1 },
        [],
        async (redisUrl) => {
          const poolsOnly = await runChaosDrainVerification({
            mode: "live",
            redisUrl,
            queueLayout: "pools",
          });
          assertEquals(poolsOnly.passed, true);

          const legacyOnly = await runChaosDrainVerification({
            mode: "live",
            redisUrl,
            queueLayout: "legacy",
          });
          assertEquals(legacyOnly.passed, false);

          const both = await runChaosDrainVerification({
            mode: "live",
            redisUrl,
            queueLayout: "both",
          });
          assertEquals(both.passed, false);
        },
      );

      const parsedArgs = parseChaosArgs(["--queue-layout", "pools"]);
      assertEquals(parsedArgs.queueLayout, "pools");
    },
  },
  {
    name:
      "contest-load-test --live: 压测前自动完成域成员加入与竞赛报名（含 409 幂等与 /members 兜底）",
    fn: async () => {
      const eventLog: string[] = [];
      let seq = 0;

      const fakeFetch: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const auth = new Headers(init?.headers).get("Authorization") ?? "";
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined;

        if (method === "GET" && url.pathname === "/api/v1/domains/club") {
          const isMember = auth === "Bearer tok-u0";
          eventLog.push(`domain-check:${auth}:${isMember}`);
          return Promise.resolve(
            Response.json({
              data: {
                is_member: isMember,
                actor_id: `uid-${auth.replace("Bearer ", "")}`,
                configuration: {
                  join_policy: auth === "Bearer tok-u2" ? "invite" : "open",
                },
              },
            }),
          );
        }
        if (method === "POST" && url.pathname === "/api/v1/domains/club/join") {
          eventLog.push(`domain-join:${auth}`);
          return Promise.resolve(
            Response.json({ data: { membership: { status: "active" } } }),
          );
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/club/invitations"
        ) {
          // 模拟未开邀请路由，触发 /members 管理员加人兜底
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/club/members"
        ) {
          assertEquals(auth, "Bearer tok-admin");
          eventLog.push(`domain-add-member:${body.user_id}`);
          return Promise.resolve(
            Response.json({ data: { added: true } }, { status: 201 }),
          );
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/club/contests/c-reg/register"
        ) {
          eventLog.push(`contest-register:${auth}`);
          if (auth === "Bearer tok-u0") {
            return Promise.resolve(
              Response.json({ message: "已注册该竞赛" }, { status: 409 }),
            );
          }
          return Promise.resolve(
            Response.json({ message: "竞赛注册成功" }, { status: 201 }),
          );
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/club/contests/c-reg"
        ) {
          return Promise.resolve(
            Response.json({ data: { status: "running" } }),
          );
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/club/contests/c-reg/problems"
        ) {
          return Promise.resolve(Response.json({
            data: [{ label: "A", display_id: "P1", version_id: "v-c1" }],
          }));
        }
        if (
          method === "POST" &&
          url.pathname ===
            "/api/v1/domains/club/contests/c-reg/problems/A/submissions"
        ) {
          eventLog.push(`submit:${auth}`);
          return Promise.resolve(
            Response.json({ data: { id: `sub-${++seq}` } }, { status: 201 }),
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/club/submissions/sub-")
        ) {
          return Promise.resolve(Response.json({
            data: {
              status: "finished",
              judge_started_at: new Date().toISOString(),
            },
          }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      };

      const report = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        adminToken: "tok-admin",
        userTokens: ["tok-u0", "tok-u1", "tok-u2"],
        domainSlug: "club",
        contestId: "c-reg",
        aiProblemId: "P1",
        oiProblemId: "P1",
        priorityMix: { high: 1, medium: 0, low: 0 },
        users: 3,
        peakSubmissions: 3,
        burstWindowMs: 0,
        pollIntervalMs: 1,
        fetchFn: fakeFetch,
      });

      assertEquals(report.stats.succeeded, 3);
      assert(eventLog.includes("domain-join:Bearer tok-u1"));
      assert(eventLog.includes("domain-add-member:uid-tok-u2"));
      assert(!eventLog.includes("domain-join:Bearer tok-u0"));
      assert(eventLog.includes("contest-register:Bearer tok-u0"));
      assert(eventLog.includes("contest-register:Bearer tok-u1"));
      assert(eventLog.includes("contest-register:Bearer tok-u2"));

      const firstSubmitIdx = eventLog.findIndex((e) => e.startsWith("submit:"));
      const lastRegisterIdx = eventLog.reduce(
        (acc, e, i) => (e.startsWith("contest-register:") ? i : acc),
        -1,
      );
      assert(
        lastRegisterIdx >= 0 && firstSubmitIdx > lastRegisterIdx,
        "所有竞赛报名必须在并发提交前完成",
      );
    },
  },
  {
    name:
      "contest-load-auth: 登录、注册与竞赛报名遇 429 + Retry-After: 0 后退避重试成功",
    fn: async () => {
      const hitCounts = new Map<string, number>();
      let seq = 0;

      const bump = (key: string): number => {
        const next = (hitCounts.get(key) ?? 0) + 1;
        hitCounts.set(key, next);
        return next;
      };

      const fakeFetch: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined;
        const auth = new Headers(init?.headers).get("Authorization") ?? "";

        if (method === "POST" && url.pathname === "/api/v1/auth/register") {
          const hit = bump("register");
          if (hit === 1) {
            return Promise.resolve(
              new Response("rate limited", {
                status: 429,
                headers: { "Retry-After": "0" },
              }),
            );
          }
          return Promise.resolve(Response.json({
            data: { token: `reg-tok-${body.username}`, email_verified: true },
          }, { status: 201 }));
        }
        if (method === "POST" && url.pathname === "/api/v1/auth/login") {
          const hit = bump(`login:${body.login}`);
          if (hit === 1) {
            return Promise.resolve(
              new Response("rate limited", {
                status: 429,
                headers: { "Retry-After": "0" },
              }),
            );
          }
          return Promise.resolve(Response.json({
            data: {
              token: `login-tok-${body.login}`,
              user: { must_change_password: false },
            },
          }));
        }
        if (method === "GET" && url.pathname === "/api/v1/domains/main") {
          return Promise.resolve(Response.json({ data: { is_member: true } }));
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/main/contests/c-rl/register"
        ) {
          const hit = bump(`contest-reg:${auth}`);
          if (hit === 1) {
            return Promise.resolve(
              new Response("rate limited", {
                status: 429,
                headers: { "Retry-After": "0" },
              }),
            );
          }
          return Promise.resolve(
            Response.json({ message: "竞赛注册成功" }, { status: 201 }),
          );
        }
        if (
          method === "POST" &&
          url.pathname ===
            "/api/v1/domains/main/contests/c-rl/problems/A/submissions"
        ) {
          return Promise.resolve(
            Response.json({ data: { id: `sub-${++seq}` } }, { status: 201 }),
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/main/submissions/sub-")
        ) {
          return Promise.resolve(Response.json({
            data: {
              status: "finished",
              judge_started_at: new Date().toISOString(),
            },
          }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      };

      const report = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        userCredentials: [{ login: "u_cred_1", password: "Password123!" }],
        autoRegister: true,
        authPaceMs: 0,
        authMaxRetries: 3,
        contestId: "c-rl",
        aiProblemId: "P1",
        oiProblemId: "P1",
        contestVersionId: "v-c1",
        priorityMix: { high: 1, medium: 0, low: 0 },
        users: 2,
        peakSubmissions: 2,
        burstWindowMs: 0,
        pollIntervalMs: 1,
        fetchFn: fakeFetch,
      });

      assertEquals(report.stats.succeeded, 2);
      assertEquals(hitCounts.get("login:u_cred_1"), 2);
      assertEquals(hitCounts.get("register"), 2);
      assertEquals(hitCounts.get("contest-reg:Bearer login-tok-u_cred_1"), 2);

      // maxRetries=0 时保留 429 响应不无限重试
      const noRetryRunner = createAuthRequestRunner(
        () =>
          Promise.resolve(
            new Response("still limited", {
              status: 429,
              headers: { "Retry-After": "0" },
            }),
          ),
        { paceMs: 0, maxRetries: 0 },
      );
      const res429 = await noRetryRunner("http://mock.local/api/v1/auth/login");
      assertEquals(res429.status, 429);
      await res429.body?.cancel();
    },
  },
  {
    name:
      "contest-load-test --live: 练习提交携带新版(v2)而竞赛提交携带竞赛锁定版(v1)",
    fn: async () => {
      const contestVersions: string[] = [];
      const practiceVersions: string[] = [];
      let seq = 0;

      const fakeFetch: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined;

        if (method === "GET" && url.pathname === "/api/v1/domains/school") {
          return Promise.resolve(Response.json({ data: { is_member: true } }));
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/school/contests/c-ver/register"
        ) {
          return Promise.resolve(
            Response.json({ message: "竞赛注册成功" }, { status: 201 }),
          );
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/problems/P101"
        ) {
          return Promise.resolve(Response.json({ version_id: "v2-ai" }));
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/problems/P102"
        ) {
          return Promise.resolve(Response.json({ version_id: "v2-oi" }));
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/contests/c-ver"
        ) {
          return Promise.resolve(
            Response.json({ data: { status: "running" } }),
          );
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/contests/c-ver/problems"
        ) {
          return Promise.resolve(Response.json({
            data: [
              { label: "A", display_id: "P101", version_id: "v1-ai" },
              { label: "B", display_id: "P102", version_id: "v1-oi" },
            ],
          }));
        }
        if (
          method === "POST" &&
          /^\/api\/v1\/domains\/school\/contests\/c-ver\/problems\/[AB]\/submissions$/
            .test(url.pathname)
        ) {
          contestVersions.push(String(body.version_id));
          return Promise.resolve(
            Response.json({ data: { id: `sub-${++seq}` } }, { status: 201 }),
          );
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/school/submissions"
        ) {
          practiceVersions.push(String(body.version_id));
          return Promise.resolve(
            Response.json({ data: { id: `sub-${++seq}` } }, { status: 201 }),
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/school/submissions/sub-")
        ) {
          return Promise.resolve(Response.json({
            data: {
              status: "finished",
              judge_started_at: new Date().toISOString(),
            },
          }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      };

      const report = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        userTokens: ["tok-u0", "tok-u1"],
        domainSlug: "school",
        contestId: "c-ver",
        aiProblemId: "P101",
        oiProblemId: "P102",
        priorityMix: { high: 0.5, medium: 0.5, low: 0 },
        users: 2,
        peakSubmissions: 6,
        aiRatio: 0.5,
        burstWindowMs: 0,
        pollIntervalMs: 1,
        fetchFn: fakeFetch,
      });

      assertEquals(report.stats.succeeded, 6);
      assertEquals(contestVersions.length, 3);
      assertEquals(practiceVersions.length, 3);
      assert(
        contestVersions.every((v) => v === "v1-ai" || v === "v1-oi"),
        `竞赛提交必须携带竞赛锁定版 v1，实际: ${contestVersions.join(",")}`,
      );
      assert(
        practiceVersions.every((v) => v === "v2-ai" || v === "v2-oi"),
        `练习提交必须携带练习版 v2，实际: ${practiceVersions.join(",")}`,
      );

      const cliParsed = parseLoadTestArgs([
        "--contest-version-id",
        "v1-cli",
        "--auth-pace-ms",
        "25",
        "--auth-max-retries",
        "4",
      ]);
      assertEquals(cliParsed.config.contestVersionId, "v1-cli");
      assertEquals(cliParsed.config.authPaceMs, 25);
      assertEquals(cliParsed.config.authMaxRetries, 4);
    },
  },
  {
    name:
      "contest-load-test --live: 混合负载预热 seed 不污染统计计数且 high/medium/low 同批并发派出",
    fn: async () => {
      const dispatchEvents: Array<{
        kind: "seed" | "high" | "medium" | "low";
        atMs: number;
        id?: string;
        targetId?: string;
      }> = [];
      let seq = 0;
      let jobSeq = 0;
      const pollHoldMs = 120;
      const subCreatedAt = new Map<string, number>();

      const fakeFetch: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined;

        if (method === "GET" && url.pathname === "/api/v1/domains/school") {
          return Promise.resolve(Response.json({ data: { is_member: true } }));
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/school/contests/c-mix/register"
        ) {
          return Promise.resolve(
            Response.json({ message: "竞赛注册成功" }, { status: 201 }),
          );
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/problems/P101"
        ) {
          return Promise.resolve(Response.json({ version_id: "v2-ai" }));
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/problems/P102"
        ) {
          return Promise.resolve(Response.json({ version_id: "v2-oi" }));
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/contests/c-mix"
        ) {
          return Promise.resolve(
            Response.json({ data: { status: "running" } }),
          );
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/contests/c-mix/problems"
        ) {
          return Promise.resolve(Response.json({
            data: [
              { label: "A", display_id: "P101", version_id: "v1-ai" },
              { label: "B", display_id: "P102", version_id: "v1-oi" },
            ],
          }));
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/submissions"
        ) {
          return Promise.resolve(Response.json({ data: [] }));
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/school/submissions"
        ) {
          const isSeed = typeof body.code === "string" &&
            body.code.includes("stress-seed-");
          if (body.problem_ref === "P102") {
            assertEquals(body.language, "cc");
          }
          const id = isSeed ? `seed-sub-${++seq}` : `timed-sub-${++seq}`;
          subCreatedAt.set(id, performance.now());
          dispatchEvents.push({
            kind: isSeed ? "seed" : "medium",
            atMs: performance.now(),
            id,
          });
          return Promise.resolve(
            Response.json({ data: { id } }, { status: 201 }),
          );
        }
        if (
          method === "POST" &&
          /^\/api\/v1\/domains\/school\/contests\/c-mix\/problems\/[AB]\/submissions$/
            .test(url.pathname)
        ) {
          const id = `timed-sub-${++seq}`;
          subCreatedAt.set(id, performance.now());
          dispatchEvents.push({
            kind: "high",
            atMs: performance.now(),
            id,
          });
          return Promise.resolve(
            Response.json({ data: { id } }, { status: 201 }),
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/school/submissions/")
        ) {
          const id = url.pathname.split("/").pop()!;
          const isSeed = id.startsWith("seed-sub-");
          const elapsed = performance.now() -
            (subCreatedAt.get(id) ?? performance.now());
          const done = isSeed || elapsed >= pollHoldMs;
          return Promise.resolve(Response.json({
            data: done
              ? {
                status: "finished",
                judge_started_at: new Date().toISOString(),
              }
              : { status: "judging", judge_started_at: null },
          }));
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/school/submission-jobs"
        ) {
          const targetId = body.scope.submissions[0].id as string;
          dispatchEvents.push({
            kind: "low",
            atMs: performance.now(),
            targetId,
          });
          return Promise.resolve(
            Response.json(
              { data: { job_id: `job-${++jobSeq}`, status: "queued" } },
              { status: 202 },
            ),
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/school/submission-jobs/job-")
        ) {
          return Promise.resolve(Response.json({
            data: { status: "completed", counts: { succeeded: 1 } },
          }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      };

      const report = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        adminToken: "tok-admin",
        userTokens: ["tok-u0", "tok-u1", "tok-u2"],
        domainSlug: "school",
        contestId: "c-mix",
        aiProblemId: "P101",
        oiProblemId: "P102",
        users: 3,
        peakSubmissions: 7,
        aiRatio: 0.5,
        burstWindowMs: 20,
        pollIntervalMs: 15,
        fetchFn: fakeFetch,
      });

      // 1) seed 不污染压测总计数与各档计数
      assertEquals(report.stats.totalSubmissions, 7);
      assertEquals(report.stats.succeeded, 7);
      assertEquals(report.stats.byPriority.high.total, 4);
      assertEquals(report.stats.byPriority.medium.total, 2);
      assertEquals(report.stats.byPriority.low.total, 1);

      const seeds = dispatchEvents.filter((e) => e.kind === "seed");
      const timed = dispatchEvents.filter((e) => e.kind !== "seed");
      const lows = timed.filter((e) => e.kind === "low");
      assertEquals(seeds.length, 1);
      assertEquals(lows.length, 1);
      assertEquals(lows[0]!.targetId, seeds[0]!.id);

      // 2) high/medium/low 必须在同一个并发突发窗口内发出（low 发出时间远早于 high/medium 轮询完成）
      const minTimedAt = Math.min(...timed.map((e) => e.atMs));
      const maxTimedAt = Math.max(...timed.map((e) => e.atMs));
      assert(seeds[0]!.atMs <= minTimedAt, "seed 必须在计时窗口前发送");
      assert(
        maxTimedAt - minTimedAt < pollHoldMs,
        `high/medium/low 应在同一个突发窗口内并发发出，当前跨度=${
          (maxTimedAt - minTimedAt).toFixed(1)
        }ms >= ${pollHoldMs}ms`,
      );
    },
  },
  {
    name:
      "resolveSubmissionQueueWaitMs: 优先使用 judge_started_at 与 created_at 计算并正确处理回退与钳位",
    fn: () => {
      // 1) 同源服务端 created_at + judge_started_at：不受本地轮询观测延迟与 e2eMs 影响
      assertEquals(
        resolveSubmissionQueueWaitMs({
          judgeStartedAt: "2026-11-26T00:00:00.025Z",
          serverCreatedAt: "2026-11-26T00:00:00.000Z",
          reqStartEpochMs: Date.parse("2026-11-26T00:00:00.000Z"),
          observedStartedAtMs: null,
          e2eMs: 220,
          submitHttpMs: 5,
        }),
        25,
      );

      // 2) 负向偏移钳位到 0（如时钟微小偏差或同毫秒取整）
      assertEquals(
        resolveSubmissionQueueWaitMs({
          judgeStartedAt: "2026-11-26T00:00:00.000Z",
          serverCreatedAt: "2026-11-26T00:00:00.010Z",
          reqStartEpochMs: Date.parse("2026-11-26T00:00:00.000Z"),
          observedStartedAtMs: null,
          e2eMs: 100,
          submitHttpMs: 5,
        }),
        0,
      );

      // 3) 缺少服务端 created_at 时回退到 reqStartEpochMs，并钳位到 [0, e2eMs]
      const reqEpoch = Date.parse("2026-11-26T00:00:01.000Z");
      assertEquals(
        resolveSubmissionQueueWaitMs({
          judgeStartedAt: "2026-11-26T00:00:01.030Z",
          reqStartEpochMs: reqEpoch,
          observedStartedAtMs: null,
          e2eMs: 120,
          submitHttpMs: 4,
        }),
        30,
      );
      assertEquals(
        resolveSubmissionQueueWaitMs({
          judgeStartedAt: "2026-11-26T00:00:05.000Z",
          reqStartEpochMs: reqEpoch,
          observedStartedAtMs: null,
          e2eMs: 90,
          submitHttpMs: 4,
        }),
        90,
      );

      // 4) judge_started_at 为 null 时依次回退 observedStartedAtMs 与 max(0, e2eMs - submitHttpMs)
      assertEquals(
        resolveSubmissionQueueWaitMs({
          judgeStartedAt: null,
          reqStartEpochMs: reqEpoch,
          observedStartedAtMs: 18,
          e2eMs: 120,
          submitHttpMs: 5,
        }),
        18,
      );
      assertEquals(
        resolveSubmissionQueueWaitMs({
          judgeStartedAt: null,
          reqStartEpochMs: reqEpoch,
          observedStartedAtMs: null,
          e2eMs: 120,
          submitHttpMs: 5,
        }),
        115,
      );
    },
  },
  {
    name:
      "contest-load --live: 首次轮询即终态时仍按服务端 judge_started_at 计算 queueWaitMs，不混入执行与轮询耗时",
    fn: async () => {
      let seq = 0;
      const pollHoldMs = 130;
      const serverTimestamps = new Map<
        string,
        { createdAtIso: string; judgeStartedAtIso: string }
      >();

      const fakeFetch: typeof fetch = async (input, init) => {
        await Promise.resolve();
        const url = new URL(String(input));
        const method = init?.method ?? "GET";

        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/school/contests/c-term/register"
        ) {
          return Response.json({ message: "竞赛注册成功" }, { status: 201 });
        }
        if (
          method === "POST" &&
          (url.pathname === "/api/v1/domains/school/submissions" ||
            /^\/api\/v1\/domains\/school\/contests\/c-term\/problems\/[AB]\/submissions$/
              .test(url.pathname))
        ) {
          const isContestHigh = url.pathname.includes("/contests/c-term/");
          const id = `sub-term-${++seq}`;
          const baseEpoch = Date.now();
          // high 排队 8ms、medium 排队 35ms，但两者首次轮询都在 pollHoldMs(130ms) 后才返回终态
          const waitMs = isContestHigh ? 8 : 35;
          const createdAtIso = new Date(baseEpoch).toISOString();
          const judgeStartedAtIso = new Date(baseEpoch + waitMs).toISOString();
          serverTimestamps.set(id, { createdAtIso, judgeStartedAtIso });
          return Response.json(
            { data: { id, created_at: createdAtIso } },
            { status: 201 },
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith(
            "/api/v1/domains/school/submissions/sub-term-",
          )
        ) {
          const id = url.pathname.split("/").pop()!;
          const ts = serverTimestamps.get(id)!;
          // 模拟评测在轮询间隙完成：首次轮询响应延迟 pollHoldMs 后直接返回 finished + judge_started_at
          await new Promise((r) => setTimeout(r, pollHoldMs));
          return Response.json({
            data: {
              status: "finished",
              created_at: ts.createdAtIso,
              judge_started_at: ts.judgeStartedAtIso,
            },
          });
        }
        return new Response("not found", { status: 404 });
      };

      const report = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        userTokens: ["tok-u0", "tok-u1"],
        domainSlug: "school",
        contestId: "c-term",
        aiProblemId: "P1",
        oiProblemId: "P2",
        versionId: "v1",
        priorityMix: { high: 0.5, medium: 0.5, low: 0 },
        users: 2,
        peakSubmissions: 4,
        burstWindowMs: 0,
        pollIntervalMs: 20,
        timeoutMs: 5000,
        fetchFn: fakeFetch,
      });

      assertEquals(report.stats.totalSubmissions, 4);
      assertEquals(report.stats.succeeded, 4);
      // 端到端耗时包含 pollHoldMs（>= 120ms），但 queueWaitMs 仅反映服务端报告的 8ms / 35ms
      assert(report.stats.e2eLatencyMs.min >= pollHoldMs - 15);
      assertEquals(report.stats.byPriority.high.queueWaitMs.avg, 8);
      assertEquals(report.stats.byPriority.medium.queueWaitMs.avg, 35);
      assert(
        report.stats.queueWaitMs.max < pollHoldMs,
        `queueWaitMs 不应混入执行与轮询等待耗时: max=${report.stats.queueWaitMs.max}ms >= ${pollHoldMs}ms`,
      );
    },
  },
  {
    name:
      "contest-load --live: rejudge low 队列按关联 judging attempt 开始时间计算 queueWaitMs，而非按 job running 派发态",
    fn: async () => {
      const seedCreatedAt = "2026-11-26T00:00:00.000Z";
      const staleJudgeStartedAt = "2026-11-26T00:00:00.005Z";
      let rejudgeJobCreatedEpoch = 0;
      let rejudgePolls = 0;
      let jobRunningObserved = false;

      const fakeFetch: typeof fetch = async (input, init) => {
        await Promise.resolve();
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : {};

        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/problems/P-OI"
        ) {
          return Response.json({ data: { current_version_id: "ver-oi-1" } });
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/school/submissions"
        ) {
          assertEquals(body.language, "cc");
          return Response.json(
            { data: { id: "sub-seed-cc", created_at: seedCreatedAt } },
            { status: 201 },
          );
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/school/submission-jobs"
        ) {
          rejudgeJobCreatedEpoch = Date.now();
          return Response.json(
            { data: { job_id: "job-low-1", status: "queued" } },
            { status: 202 },
          );
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/submission-jobs/job-low-1"
        ) {
          rejudgePolls++;
          const jobCreatedIso = new Date(rejudgeJobCreatedEpoch).toISOString();
          if (rejudgePolls <= 2) {
            // refreshJobStatus 在入队 dispatched 后立即把 job.status 标为 running，但 attempt 仍在排队
            jobRunningObserved = true;
            return Response.json({
              data: {
                id: "job-low-1",
                status: "running",
                created_at: jobCreatedIso,
                counts: { dispatched: 1 },
              },
            });
          }
          return Response.json({
            data: {
              id: "job-low-1",
              status: "completed",
              created_at: jobCreatedIso,
              counts: { succeeded: 1 },
            },
          });
        }
        if (
          method === "GET" &&
          url.pathname ===
            "/api/v1/domains/school/submission-jobs/job-low-1/items"
        ) {
          return Response.json({
            data: [
              {
                id: "item-1",
                source_id: "sub-seed-cc",
                status: rejudgePolls <= 2 ? "dispatched" : "succeeded",
                attempt_id: "att-rejudge-2",
              },
            ],
          });
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/school/submissions/sub-seed-cc"
        ) {
          if (rejudgeJobCreatedEpoch === 0) {
            return Response.json({
              data: {
                status: "finished",
                created_at: seedCreatedAt,
                judge_started_at: staleJudgeStartedAt,
              },
            });
          }
          const attemptCreatedIso = new Date(rejudgeJobCreatedEpoch + 2)
            .toISOString();
          const attemptStartedIso = new Date(rejudgeJobCreatedEpoch + 75)
            .toISOString();
          if (rejudgePolls <= 2) {
            // 仍处于队列等待中：attempt 处于 queued，提交行仍残留初次评测的旧 judge_started_at
            return Response.json({
              data: {
                status: "judging",
                created_at: seedCreatedAt,
                judge_started_at: staleJudgeStartedAt,
                latest_attempt_id: "att-rejudge-2",
                attempts: [
                  {
                    attempt_id: "att-initial-1",
                    state: "finished",
                    source: "initial",
                    created_at: seedCreatedAt,
                  },
                  {
                    attempt_id: "att-rejudge-2",
                    state: "queued",
                    source: "rejudge",
                    created_at: attemptCreatedIso,
                    started_at: null,
                  },
                ],
              },
            });
          }
          return Response.json({
            data: {
              status: "finished",
              created_at: seedCreatedAt,
              judge_started_at: attemptStartedIso,
              latest_attempt_id: "att-rejudge-2",
              attempts: [
                {
                  attempt_id: "att-rejudge-2",
                  state: "finished",
                  source: "rejudge",
                  created_at: attemptCreatedIso,
                  started_at: attemptStartedIso,
                },
              ],
            },
          });
        }
        return new Response("not found", { status: 404 });
      };

      const report = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        adminToken: "tok-admin",
        userTokens: ["tok-u0"],
        domainSlug: "school",
        oiProblemId: "P-OI",
        aiRatio: 0,
        priorityMix: { high: 0, medium: 0, low: 1 },
        rejudgeSubmissionIds: ["sub-seed-cc"],
        users: 1,
        peakSubmissions: 1,
        burstWindowMs: 0,
        pollIntervalMs: 10,
        timeoutMs: 5000,
        fetchFn: fakeFetch,
      });

      assertEquals(jobRunningObserved, true);
      assertEquals(report.stats.totalSubmissions, 1);
      assertEquals(report.stats.succeeded, 1);
      assertEquals(report.stats.byPriority.low.queueWaitMs.avg, 75);
    },
  },
  {
    name:
      "contest-load-auth: 非 E2E 公开注册缺少验证令牌且登录返回 email_verified=false 时回退管理员开号",
    fn: async () => {
      const submittedAuths = new Set<string>();
      const unverifiedUsers = new Set<string>();
      let seq = 0;

      const fakeFetch: typeof fetch = async (input, init) => {
        await Promise.resolve();
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined;
        const auth = new Headers(init?.headers).get("Authorization") ?? "";

        if (method === "POST" && url.pathname === "/api/v1/auth/register") {
          unverifiedUsers.add(body.username);
          // 非 E2E 环境：省略 email_verification_token 且 email_verified=false
          return Response.json({
            data: {
              id: `pub-${body.username}`,
              username: body.username,
              email_verified: false,
              email_verification_sent: true,
            },
          }, { status: 201 });
        }
        if (method === "POST" && url.pathname === "/api/v1/auth/login") {
          const isUnverified = unverifiedUsers.has(body.login);
          return Response.json({
            data: {
              token: isUnverified
                ? `unverified-${body.login}`
                : `verified-${body.login}`,
              user: {
                must_change_password: false,
                email_verified: !isUnverified,
              },
            },
          });
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/admin/identity/users/import"
        ) {
          assertEquals(auth, "Bearer jwt-admin");
          const users = body.users as Array<{
            username: string;
            email: string;
            password: string;
          }>;
          for (const u of users) {
            if (unverifiedUsers.has(u.username)) {
              return Response.json(
                { message: `用户名已存在: ${u.username}` },
                { status: 400 },
              );
            }
          }
          const created = users.map((u, i) => ({
            id: `adm-${i}`,
            username: u.username,
            email: u.email,
            password: u.password,
          }));
          return Response.json({ data: created }, { status: 201 });
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/main/submissions"
        ) {
          if (auth.startsWith("Bearer unverified-")) {
            return Response.json(
              { code: "EMAIL_VERIFICATION_REQUIRED", message: "请先验证邮箱" },
              { status: 403 },
            );
          }
          submittedAuths.add(auth);
          return Response.json(
            { data: { id: `sub-${++seq}` } },
            { status: 201 },
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/main/submissions/sub-")
        ) {
          return Response.json({
            data: {
              status: "finished",
              judge_started_at: new Date().toISOString(),
            },
          });
        }
        return new Response("not found", { status: 404 });
      };

      const report = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        adminToken: "jwt-admin",
        aiProblemId: "P1",
        oiProblemId: "P2",
        versionId: "v1",
        priorityMix: { high: 0, medium: 1, low: 0 },
        users: 2,
        peakSubmissions: 4,
        burstWindowMs: 0,
        pollIntervalMs: 5,
        fetchFn: fakeFetch,
      });

      assertEquals(report.stats.totalSubmissions, 4);
      assertEquals(report.stats.succeeded, 4);
      assertEquals(submittedAuths.size, 2);
      for (const a of submittedAuths) {
        assert(a.startsWith("Bearer verified-"));
      }
    },
  },
  {
    name:
      "contest-load --live: 轮询响应体挂起、请求头挂起或信号量阻塞超过 timeoutMs 时按超时收敛不挂死",
    fn: async () => {
      let abortedCount = 0;
      const fakeFetch: typeof fetch = async (input, init) => {
        await Promise.resolve();
        const url = new URL(String(input));
        const method = init?.method ?? "GET";

        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/main/submissions"
        ) {
          return Response.json(
            { data: { id: "sub-stall-body" } },
            { status: 201 },
          );
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/domains/main/submissions/sub-stall-body"
        ) {
          // 模拟连接已建立但响应体读取永久挂起（直至 AbortSignal 取消）
          return new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener("abort", () => {
                  abortedCount++;
                  try {
                    controller.error(new Error("aborted"));
                  } catch {
                    // ignore
                  }
                });
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      };

      const started = performance.now();
      const report = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        userTokens: ["tok-u0"],
        aiProblemId: "P1",
        oiProblemId: "P2",
        versionId: "v1",
        priorityMix: { high: 0, medium: 1, low: 0 },
        users: 1,
        peakSubmissions: 1,
        burstWindowMs: 0,
        pollIntervalMs: 10,
        timeoutMs: 80,
        fetchFn: fakeFetch,
      });
      const elapsed = performance.now() - started;

      assertEquals(report.stats.totalSubmissions, 1);
      assertEquals(report.stats.timeouts, 1);
      assert(abortedCount >= 1, "超时应主动中止挂起中的轮询请求");
      assert(
        elapsed < 500,
        `挂起请求应在 timeoutMs 附近结束，实际耗时=${elapsed.toFixed(1)}ms`,
      );

      // 场景 2：响应头挂起（未遵循 signal）+ pollConcurrency=1 阻塞信号量，仍应在 timeoutMs 附近收敛
      let postSeq = 0;
      const stallHeadersAndSemaphoreFetch: typeof fetch = async (
        input,
        init,
      ) => {
        await Promise.resolve();
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/main/submissions"
        ) {
          return Response.json(
            { data: { id: `sub-hang-${++postSeq}` } },
            { status: 201 },
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/main/submissions/sub-hang-")
        ) {
          // 刻意忽略 AbortSignal 永不 resolve，验证 runWithDeadline + 可取消信号量仍可按期收敛
          return await new Promise<Response>(() => {});
        }
        return new Response("not found", { status: 404 });
      };

      const started2 = performance.now();
      const report2 = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        userTokens: ["tok-u0", "tok-u1"],
        aiProblemId: "P1",
        oiProblemId: "P2",
        versionId: "v1",
        priorityMix: { high: 0, medium: 1, low: 0 },
        users: 2,
        peakSubmissions: 2,
        burstWindowMs: 0,
        pollConcurrency: 1,
        pollIntervalMs: 10,
        timeoutMs: 80,
        fetchFn: stallHeadersAndSemaphoreFetch,
      });
      const elapsed2 = performance.now() - started2;
      assertEquals(report2.stats.totalSubmissions, 2);
      assertEquals(report2.stats.timeouts, 2);
      assert(
        elapsed2 < 500,
        `信号量/响应头挂起应在 timeoutMs 附近结束，实际耗时=${
          elapsed2.toFixed(1)
        }ms`,
      );
    },
  },
  {
    name:
      "contest-load-auth: 公开注册省略 email_verified 且登录返回 email_verified=false 时拒绝接收并回退管理员开号",
    fn: async () => {
      const submittedAuths = new Set<string>();
      const unverifiedUsers = new Set<string>();
      let seq = 0;

      const fakeFetch: typeof fetch = async (input, init) => {
        await Promise.resolve();
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined;
        const auth = new Headers(init?.headers).get("Authorization") ?? "";

        if (method === "POST" && url.pathname === "/api/v1/auth/register") {
          unverifiedUsers.add(body.username);
          // 既无 email_verification_token 也无 email_verified 字段
          return Response.json({
            data: { id: `pub-${body.username}`, username: body.username },
          }, { status: 201 });
        }
        if (method === "POST" && url.pathname === "/api/v1/auth/login") {
          const isUnverified = unverifiedUsers.has(body.login);
          return Response.json({
            data: {
              token: isUnverified
                ? `unverified-${body.login}`
                : `verified-${body.login}`,
              user: {
                must_change_password: false,
                email_verified: !isUnverified,
              },
            },
          });
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/admin/identity/users/import"
        ) {
          assertEquals(auth, "Bearer jwt-admin");
          const users = body.users as Array<{
            username: string;
            email: string;
            password: string;
          }>;
          for (const u of users) {
            if (unverifiedUsers.has(u.username)) {
              return Response.json(
                { message: `用户名已存在: ${u.username}` },
                { status: 400 },
              );
            }
          }
          const created = users.map((u, i) => ({
            id: `adm-${i}`,
            username: u.username,
            email: u.email,
            password: u.password,
          }));
          return Response.json({ data: created }, { status: 201 });
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/domains/main/submissions"
        ) {
          submittedAuths.add(auth);
          return Response.json(
            { data: { id: `sub-${++seq}` } },
            { status: 201 },
          );
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/v1/domains/main/submissions/sub-")
        ) {
          return Response.json({
            data: {
              status: "finished",
              judge_started_at: new Date().toISOString(),
            },
          });
        }
        return new Response("not found", { status: 404 });
      };

      const report = await runContestLoadTest({
        mode: "live",
        baseUrl: "http://mock.local",
        adminToken: "jwt-admin",
        aiProblemId: "P1",
        oiProblemId: "P2",
        versionId: "v1",
        priorityMix: { high: 0, medium: 1, low: 0 },
        users: 2,
        peakSubmissions: 2,
        burstWindowMs: 0,
        pollIntervalMs: 5,
        fetchFn: fakeFetch,
      });

      assertEquals(report.stats.succeeded, 2);
      assertEquals(submittedAuths.size, 2);
      for (const a of submittedAuths) {
        assert(a.startsWith("Bearer verified-"));
      }
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
