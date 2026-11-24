import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import type { Context } from "hono";
import { AppError, NotFoundError } from "../../shared/base/errors.ts";
import type { AuthEnv } from "../../modules/access/index.ts";
import type { LlmSubmissionSummaryData } from "../../modules/platform/index.ts";
import {
  createEvaluationFeedbackRouter,
  extractFeedbackMetrics,
  extractVisibleCasesAndBadcases,
  type FeedbackServiceDeps,
  getSelfTestFeedback,
  getSubmissionFeedback,
  resolveIncludeMessagesFlag,
} from "./index.ts";

function makeWorkspaceAccess(options: {
  domainId?: string;
  platformAdmin?: boolean;
  permissions?: string[];
} = {}) {
  return {
    domain: {
      id: options.domainId ?? "domain-1",
      slug: "main",
      name: "Main",
    },
    platformAdmin: options.platformAdmin ?? false,
    context: {
      domainPermissions: new Set(options.permissions ?? []),
    },
  } as unknown as Awaited<ReturnType<FeedbackServiceDeps["loadWorkspace"]>>;
}

function makeSampleGatewayData(
  includeMessages: boolean,
): LlmSubmissionSummaryData {
  return {
    summary: {
      total_calls: 2,
      error_calls: 1,
      prompt_tokens: 150,
      completion_tokens: 50,
      cached_prompt_tokens: 30,
      total_tokens: 200,
      estimated_cost: 8,
      total_latency_ms: 420,
      avg_latency_ms: 210,
      p95_latency_ms: 300,
      models: [
        {
          model: "deepseek-chat",
          calls: 2,
          total_tokens: 200,
          estimated_cost: 8,
        },
      ],
    },
    traces: [
      {
        id: "t1",
        seq: 1,
        model: "deepseek-chat",
        status: "ok",
        error_code: null,
        prompt_tokens: 100,
        completion_tokens: 40,
        cached_prompt_tokens: 30,
        total_tokens: 140,
        estimated_cost: 5,
        latency_ms: 120,
        offset_ms: 0,
        created_at: "2026-11-24T10:00:00.000Z",
        request_params: { temperature: 0 },
        ...(includeMessages
          ? { request_messages: [{ role: "user", content: "hello" }] }
          : {}),
      },
      {
        id: "t2",
        seq: 2,
        model: "deepseek-chat",
        status: "error",
        error_code: "upstream_500",
        prompt_tokens: 50,
        completion_tokens: 10,
        cached_prompt_tokens: 0,
        total_tokens: 60,
        estimated_cost: 3,
        latency_ms: 300,
        offset_ms: 200,
        created_at: "2026-11-24T10:00:00.200Z",
        request_params: { temperature: 0 },
        ...(includeMessages
          ? { request_messages: [{ role: "user", content: "retry" }] }
          : {}),
      },
    ],
  };
}

function makeBaseDeps(
  overrides: Partial<FeedbackServiceDeps> = {},
): FeedbackServiceDeps {
  return {
    loadWorkspace: () => Promise.resolve(makeWorkspaceAccess()),
    getDomainSubmission: () =>
      Promise.resolve({
        id: "sub-1",
        user_id: "user-1",
        domain_id: "domain-1",
        domain_problem_binding_id: "bind-1",
        reference: {
          problem_id: "prob-1",
          source_domain_id: "domain-1",
          source_domain_slug: "main",
          number: 1,
          qualified_ref: "main:1",
          display_ref: "P1",
        },
        resource_available: true,
        result_visibility: "cases",
        effective_attempt_id: "att-eff",
        latest_attempt_id: "att-lat",
        attempts: [{ attempt_id: "att-eff" }, { attempt_id: "att-lat" }],
        result: {
          status: "finished",
          score: 5000,
          details: {
            cases: [
              {
                case_id: "v1",
                status: "AC",
                visibility: "visible",
                score: 100,
                max_score: 100,
                time_ms: 40,
                memory_kb: 512,
                input: "1 2",
                expected_output: "3",
                actual_output: "3",
              },
              {
                case_id: "v2",
                status: "WA",
                visibility: "visible",
                score: 0,
                max_score: 100,
                error_type: "format_mismatch",
                reasoning: "缺少关键字段",
                time_ms: 80,
                memory_kb: 600,
                input: "4 5",
                expected_output: "9",
                actual_output: "8",
              },
              {
                case_id: "h1",
                status: "WA",
                visibility: "hidden",
                score: 0,
                max_score: 100,
                error_type: "secret_err",
                reasoning: "secret reasoning",
                input: "secret in",
                expected_output: "secret exp",
                actual_output: "secret act",
              },
            ],
          },
        },
      }),
    getDomainSelfTest: () =>
      Promise.resolve({
        id: "st-1",
        user_id: "user-1",
        problem_id: "prob-1",
        language: "python3",
        code: "print(1)",
        progress: null,
        file_name: null,
        status: "finished",
        result_status: "finished",
        score: 0,
        output: null,
        output_truncated: null,
        details: {
          oi: {
            subtasks: [
              {
                cases: [
                  {
                    case_id: "sample_1",
                    status: "WA",
                    stdout: "wrong",
                    time_ms: 25,
                    memory_kb: 256,
                  },
                ],
              },
            ],
          },
        },
        time_ms: 25,
        memory_kb: 256,
        judge_started_at: null,
        judge_finished_at: null,
        created_at: "2026-11-24T10:00:00.000Z",
        domain_id: "domain-1",
        domain_problem_binding_id: "bind-1",
        reference: {
          problem_id: "prob-1",
          display_ref: "P1",
          owner_slug: "main",
          number: 1,
          shared: false,
        },
        resource_available: true,
        version_id: "ver-1",
        assignment_origin: null,
      }) as unknown as ReturnType<FeedbackServiceDeps["getDomainSelfTest"]>,
    getSubmissionLlmSummary: (query) =>
      Promise.resolve({
        available: true,
        data: makeSampleGatewayData(Boolean(query.include_messages)),
      }),
    isTeacherForStudent: () => Promise.resolve(false),
    submissionHasAttempt: () => Promise.resolve(false),
    getSelfTestRunId: () => Promise.resolve("run-st-1"),
    ...overrides,
  };
}

Deno.test("evaluation-feedback: extractVisibleCasesAndBadcases 严禁泄露 hidden 用例", () => {
  const { visibleCases, badcases } = extractVisibleCasesAndBadcases(
    {
      cases: [
        {
          case_id: "v-ok",
          status: "AC",
          visibility: "visible",
          score: 100,
          max_score: 100,
        },
        {
          case_id: "v-partial",
          status: "AC",
          visibility: "visible",
          score: 60,
          max_score: 100,
          reasoning: "未满分",
        },
        {
          case_id: "h-vis",
          status: "WA",
          visibility: "hidden",
          input: "secret",
          expected_output: "secret",
          actual_output: "secret",
        },
        {
          case_id: "h-flag",
          status: "WA",
          hidden: true,
          input: "secret2",
        },
      ],
    },
    { isSelfTest: false },
  );

  assertEquals(visibleCases.map((c) => c.case_id), ["v-ok", "v-partial"]);
  assertEquals(badcases.map((c) => c.case_id), ["v-partial"]);
  assertEquals(badcases[0]!.reasoning, "未满分");

  // 传统分组结构：hidden 分组永不进入 badcases
  const legacy = extractVisibleCasesAndBadcases(
    {
      visible: {
        cases: [{ id: "vis1", status: "WA", expected: "a", actual: "b" }],
      },
      hidden: {
        cases: [{ id: "hid1", status: "WA", expected: "s1", actual: "s2" }],
      },
    },
    { isSelfTest: false },
  );
  assertEquals(legacy.badcases.map((c) => c.case_id), ["vis1"]);

  // 正式 OI 子任务缺少显式 visibility='visible' 时视作隐藏
  const formalOi = extractVisibleCasesAndBadcases(
    { oi: { subtasks: [{ cases: [{ case_id: "oi1", status: "WA" }] }] } },
    { isSelfTest: false },
  );
  assertEquals(formalOi.badcases, []);
});

Deno.test("evaluation-feedback: extractFeedbackMetrics 解析显式 metrics 并支持可见用例派生", () => {
  const explicit = extractFeedbackMetrics(
    {
      metrics: [
        { key: "accuracy", label: "准确率", score: 85, max_score: 100 },
        { key: "faithfulness", label: "忠实度", score: 0.9, max_score: 1 },
      ],
    },
    [],
  );
  assertEquals(explicit, [
    { key: "accuracy", label: "准确率", score: 85, max_score: 100 },
    { key: "faithfulness", label: "忠实度", score: 0.9, max_score: 1 },
  ]);

  const { visibleCases } = extractVisibleCasesAndBadcases(
    {
      cases: [
        {
          case_id: "c1",
          status: "AC",
          visibility: "visible",
          score: 100,
          max_score: 100,
          time_ms: 100,
        },
        {
          case_id: "c2",
          status: "WA",
          visibility: "visible",
          score: 0,
          max_score: 100,
          time_ms: 100,
        },
      ],
    },
    { isSelfTest: false },
  );
  const derived = extractFeedbackMetrics({}, visibleCases, 5000, {
    total_calls: 4,
    error_calls: 1,
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_prompt_tokens: 0,
    total_tokens: 0,
    estimated_cost: 0,
    total_latency_ms: 0,
    avg_latency_ms: 0,
    p95_latency_ms: 0,
    models: [],
  });
  assertEquals(derived.map((m) => m.key), [
    "pass_rate",
    "avg_score_rate",
    "time_efficiency",
    "llm_reliability",
  ]);
  assertEquals(derived[0]!.score, 50);
  assertEquals(derived[1]!.score, 50);
  assertEquals(derived[3]!.score, 75);
});

Deno.test("evaluation-feedback: 非 owner 且无读全权限返回 404；教师可看；hidden 与撤销资源不可见", async () => {
  // 非 owner 无权限
  await assertRejects(
    () =>
      getSubmissionFeedback("main", "sub-1", "other-user", {}, makeBaseDeps()),
    NotFoundError,
  );

  // 教师可查看所属学生提交
  const teacherView = await getSubmissionFeedback(
    "main",
    "sub-1",
    "teacher-1",
    { includeMessages: "1" },
    makeBaseDeps({ isTeacherForStudent: () => Promise.resolve(true) }),
  );
  assertEquals(teacherView.visible, true);
  assertEquals(teacherView.traces[0]!.request_messages?.length, 1);

  // result_visibility === 'hidden' 不调用 Gateway 并全量清空
  let gatewayCalled = false;
  const hiddenRes = await getSubmissionFeedback(
    "main",
    "sub-1",
    "user-1",
    {},
    makeBaseDeps({
      getDomainSubmission: async () => {
        const base = await makeBaseDeps().getDomainSubmission(
          "main",
          "sub-1",
          "user-1",
        );
        return { ...base, result_visibility: "hidden" };
      },
      getSubmissionLlmSummary: () => {
        gatewayCalled = true;
        return Promise.resolve({ available: false, data: null });
      },
    }),
  );
  assertEquals(gatewayCalled, false);
  assertEquals(hiddenRes, {
    visible: false,
    visibility: "hidden",
    attempt_id: null,
    gateway_available: false,
    summary: null,
    metrics: [],
    traces: [],
    badcases: [],
  });

  // !resource_available 同样返回 visible: false
  const revokedRes = await getSubmissionFeedback(
    "main",
    "sub-1",
    "user-1",
    {},
    makeBaseDeps({
      getDomainSubmission: async () => {
        const base = await makeBaseDeps().getDomainSubmission(
          "main",
          "sub-1",
          "user-1",
        );
        return { ...base, resource_available: false };
      },
    }),
  );
  assertEquals(revokedRes.visible, false);
  assertEquals(revokedRes.badcases, []);
});

Deno.test("evaluation-feedback: summary 模式不返回 traces/badcases；cases 模式门控 request_messages", async () => {
  const summaryMode = await getSubmissionFeedback(
    "main",
    "sub-1",
    "user-1",
    {},
    makeBaseDeps({
      getDomainSubmission: async () => {
        const base = await makeBaseDeps().getDomainSubmission(
          "main",
          "sub-1",
          "user-1",
        );
        return {
          ...base,
          result_visibility: "summary",
          result: {
            status: "finished",
            score: 8000,
            details: {
              metrics: [{
                key: "quality",
                label: "质量",
                score: 80,
                max_score: 100,
              }],
            },
          },
        };
      },
    }),
  );
  assertEquals(summaryMode.visible, true);
  assertEquals(summaryMode.visibility, "summary");
  assertEquals(summaryMode.summary?.total_calls, 2);
  assertEquals(summaryMode.metrics.length, 1);
  assertEquals(summaryMode.traces, []);
  assertEquals(summaryMode.badcases, []);

  // 普通用户即使传 ?include_messages=1 也绝不返回 request_messages
  let capturedInclude = true;
  const studentCases = await getSubmissionFeedback(
    "main",
    "sub-1",
    "user-1",
    { includeMessages: "1" },
    makeBaseDeps({
      getSubmissionLlmSummary: (query) => {
        capturedInclude = Boolean(query.include_messages);
        return Promise.resolve({
          available: true,
          data: makeSampleGatewayData(capturedInclude),
        });
      },
    }),
  );
  assertEquals(capturedInclude, false);
  assertEquals(studentCases.traces[0]!.request_messages, undefined);
  // hidden badcase h1 必须被过滤，只剩 v2
  assertEquals(studentCases.badcases.map((b) => b.case_id), ["v2"]);
  assertEquals(studentCases.badcases[0]!.error_type, "format_mismatch");
});

Deno.test("evaluation-feedback: attempt_id 校验、Gateway 降级与自测反馈", async () => {
  // 无效 attempt_id 拒绝
  await assertRejects(
    () =>
      getSubmissionFeedback(
        "main",
        "sub-1",
        "user-1",
        { attemptId: "foreign-att" },
        makeBaseDeps(),
      ),
    NotFoundError,
  );

  // Gateway 不可用时优雅降级
  const degraded = await getSubmissionFeedback(
    "main",
    "sub-1",
    "user-1",
    {},
    makeBaseDeps({
      getSubmissionLlmSummary: () =>
        Promise.resolve({ available: false, data: null }),
    }),
  );
  assertEquals(degraded.visible, true);
  assertEquals(degraded.gateway_available, false);
  assertEquals(degraded.summary, null);
  assertEquals(degraded.traces, []);
  assertEquals(degraded.badcases.length, 1);

  // 自测反馈默认携带脱敏消息、使用 judge_run_id 并解析 stdout 为 actual_output
  let capturedRunId: string | undefined;
  const selfTestRes = await getSelfTestFeedback(
    "main",
    "st-1",
    "user-1",
    {} as Context,
    {},
    makeBaseDeps({
      getSubmissionLlmSummary: (query) => {
        capturedRunId = query.attempt_id;
        return Promise.resolve({
          available: true,
          data: makeSampleGatewayData(Boolean(query.include_messages)),
        });
      },
    }),
  );
  assertEquals(capturedRunId, "run-st-1");
  assertEquals(selfTestRes.visible, true);
  assertEquals(selfTestRes.traces[0]!.request_messages?.length, 1);
  assertEquals(selfTestRes.badcases[0]!.case_id, "sample_1");
  assertEquals(selfTestRes.badcases[0]!.actual_output, "wrong");
  assertEquals(
    resolveIncludeMessagesFlag({
      isSelfTest: true,
      isPrivileged: false,
      rawQuery: "0",
    }),
    false,
  );
});

Deno.test("evaluation-feedback routes: 鉴权与提交/自测反馈 HTTP 契约", async () => {
  // 真实 authMiddleware 下未携带令牌应返回 401
  const realAuthApp = new Hono<AuthEnv>();
  realAuthApp.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { error: err.message, code: err.code },
        err.statusCode as 401 | 404,
      );
    }
    return c.json({ error: "internal" }, 500);
  });
  realAuthApp.route("/api/v1", createEvaluationFeedbackRouter(makeBaseDeps()));
  const unauthRes = await realAuthApp.request(
    "/api/v1/domains/main/submissions/sub-1/feedback",
  );
  assertEquals(unauthRes.status, 401);

  // 注入认证用户验证路由参数与 Cache-Control
  const authedApp = new Hono<AuthEnv>();
  authedApp.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { error: err.message, code: err.code },
        err.statusCode as 401 | 404,
      );
    }
    return c.json({ error: "internal" }, 500);
  });
  authedApp.route(
    "/api/v1",
    createEvaluationFeedbackRouter(makeBaseDeps(), async (c, next) => {
      c.set("userId", "user-1");
      await next();
    }),
  );

  const subRes = await authedApp.request(
    "/api/v1/domains/main/submissions/sub-1/feedback?attempt_id=att-lat",
  );
  assertEquals(subRes.status, 200);
  assertEquals(subRes.headers.get("Cache-Control"), "no-store");
  const subJson = await subRes.json() as {
    data: { attempt_id: string; badcases: Array<{ case_id: string }> };
  };
  assertEquals(subJson.data.attempt_id, "att-lat");
  assertEquals(subJson.data.badcases.map((b) => b.case_id), ["v2"]);

  const stRes = await authedApp.request(
    "/api/v1/domains/main/self-tests/st-1/feedback",
  );
  assertEquals(stRes.status, 200);
  assertEquals(stRes.headers.get("Cache-Control"), "no-store");
  const stJson = await stRes.json() as {
    data: { attempt_id: string; badcases: Array<{ case_id: string }> };
  };
  assertEquals(stJson.data.attempt_id, "run-st-1");
  assertEquals(stJson.data.badcases.map((b) => b.case_id), ["sample_1"]);
});
