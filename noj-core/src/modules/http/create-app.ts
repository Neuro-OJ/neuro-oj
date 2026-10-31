import { Hono } from "hono";
import { accountNotificationRouter } from "./account-notifications.ts";
import { cors } from "hono/cors";
import { createHealthRouter } from "../platform/observability/routes/health.ts";
import { observability } from "../platform/observability/write.ts";
import { registerPlatformMetrics } from "../platform/observability/metrics/platform.ts";
import {
  emptyJudgeSnapshot,
  readJudgeNodeReports,
  registerJudgeHeartbeatProvider,
} from "../platform/observability/services/judge-heartbeat.ts";
import { renderPrometheusMetrics } from "../platform/observability/services/snapshot.ts";
import { getQueueHealth } from "../evaluations/services/queue.ts";
import { registerSubmissionObservability } from "../evaluations/observability.ts";
import { registerDbHealthProbe } from "../../shared/db/connection.ts";
import { registerRedisHealthProbe } from "../../shared/mq/connection.ts";
import { normalizeMetricRoute } from "../../shared/observability/registry.ts";
import admin from "./admin/index.ts";
import { identityRouter } from "../access/identity/routes/index.ts";
import { catalogRouter } from "../problems/routes/index.ts";
import { submissionRouter } from "../evaluations/routes/index.ts";
import { queryRouter } from "../read-models/queries/routes/index.ts";
import { searchRouter } from "../read-models/search/routes/index.ts";
import { contestRouter } from "../contests/routes/index.ts";
import { communityRouter } from "../communication/community/routes/index.ts";
import { messagingRouter } from "../communication/messaging/routes/index.ts";
import { systemRouter } from "../platform/system/routes/index.ts";
import { internalLlmPolicyRouter } from "../platform/system/routes/internal-llm-policy.ts";
import { createInternalDrainRouter } from "../platform/system/routes/internal-drain.ts";
import { legalRouter } from "../platform/legal/routes/index.ts";
import { workspaceRouter } from "../access/workspace/routes/index.ts";
import { domainProblemsRouter } from "../problems/routes/domain-problems.ts";
import { domainTrainingsRouter } from "../problems/routes/domain-trainings.ts";
import { domainResourceManagementRouter } from "../problems/routes/domain-resource-management.ts";
import { domainSubmissionsRouter } from "../evaluations/routes/domain-submissions.ts";
import { domainSubmissionJobsRouter } from "../evaluations/routes/domain-submission-jobs.ts";
import { ownSubmissionHistoryRouter } from "../evaluations/routes/own-submission-history.ts";
import { domainSubmissionSse } from "../evaluations/routes/sse.ts";
import { domainObjectiveRouter } from "../evaluations/routes/domain-objective.ts";
import { domainContestRouter } from "../contests/routes/domain-contests.ts";
import { domainCommunityRouter } from "../communication/community/routes/domain-community.ts";
import { domainQueryRouter } from "../read-models/queries/routes/domain-query.ts";
import { domainStatsSse } from "../read-models/queries/routes/sse.ts";
import { domainSearchRouter } from "../read-models/search/routes/search.ts";
import { domainLlmRouter } from "../platform/gateway/routes/domain-llm.ts";
import { educationRouter } from "../education/routes/index.ts";
import { instanceAccessMiddleware } from "../access/workspace/middleware/instance-access.ts";
import submissionSse from "../evaluations/routes/sse.ts";
import { AppError } from "../../shared/base/errors.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "core"]);
import { listJudgeImages } from "../platform/services/judge-images.ts";
import { banlistMiddleware } from "../access/identity/middleware/banlist.ts";
import { requestContext } from "../platform/observability/middleware/request-context.ts";
import { httpMetricsMiddleware } from "../platform/observability/middleware/http-metrics.ts";
import { getSetting } from "../platform/services/system-settings.ts";
import { registerSystemEmailMetrics } from "../platform/system/observability.ts";
import { SECONDS_PER_DAY } from "../../shared/base/constants.ts";
import { securityHeaders } from "../../shared/http/security-headers.ts";
import { createMaintenanceMode } from "../../shared/http/maintenance.ts";
import { getRedis } from "../../shared/mq/connection.ts";
import type { SseStreamScope } from "../../shared/sse/sse-stream.ts";
import { registerRuntimeObservability } from "../runtime/index.ts";
import { registerEducationObservability } from "../education/index.ts";
import { retiredEndpointMiddleware } from "./retired-endpoints.ts";

/** 应用装配选项；外部运行资源由入口创建并传入。 */
export interface CreateAppOptions {
  /** 本次 Core 装配拥有的 SSE 流 scope；生产入口显式注入。 */
  sseStreamScope?: SseStreamScope;
  /** 是否返回旧默认域写入的 410；未显式传入时仅生产环境启用。 */
  retireLegacyEndpoints?: boolean;
}

/** 创建并配置 Hono 应用实例。 */
export function createApp(options: CreateAppOptions = {}): Hono {
  const app = new Hono();
  const observabilityRegistry = observability;
  registerPlatformMetrics(observabilityRegistry);
  registerSystemEmailMetrics(observabilityRegistry);
  registerDbHealthProbe(observabilityRegistry);
  registerRedisHealthProbe(observabilityRegistry);
  registerSubmissionObservability(observabilityRegistry);
  registerJudgeHeartbeatProvider(observabilityRegistry);
  registerRuntimeObservability(observabilityRegistry);
  registerEducationObservability(observabilityRegistry);

  // 直连 core 时仍输出基础安全头。HSTS 由 TLS 终止边缘负责，CSP 由页面层负责。
  app.use("*", securityHeaders);

  // 显式 app 级注入 SSE scope：避免生产关闭流程依赖模块级全局默认值。
  // 旧测试与未注入的调用仍可由 createSseStream 的默认 scope 兜底。
  if (options.sseStreamScope) {
    const scope = options.sseStreamScope;
    app.use("*", async (c, next) => {
      (c as unknown as { set(key: string, value: unknown): void }).set(
        "sseStreamScope",
        scope,
      );
      await next();
    });
  }

  // 请求上下文中间件（最外层）：为每个请求生成 request_id，
  // 写入 context 供 onError 复用，并包裹后续处理使日志自动带 request_id。
  app.use("*", requestContext);
  app.use("*", httpMetricsMiddleware(observabilityRegistry));

  // CORS 中间件
  // - 开发环境：只允许本地 UI 开发端口，避免 credentials 与通配来源组合
  // - 生产环境：从 CORS_ALLOWED_ORIGINS 环境变量读取白名单（逗号分隔）
  // - credentials: true 支持 noj-ui 通过 HTTP-only Cookie 携带认证信息
  const allowedOrigins = Deno.env.get("CORS_ALLOWED_ORIGINS")?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isProd = Deno.env.get("NOJ_ENV") === "production";
  const retireLegacyEndpoints = options.retireLegacyEndpoints ?? isProd;
  const developmentOrigins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];

  app.use(
    "*",
    cors({
      origin: isProd
        ? (allowedOrigins ?? []) // 生产环境未配置白名单则拒绝跨域
        : developmentOrigins,
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "If-Match",
        "Idempotency-Key",
      ],
      exposeHeaders: [
        "Retry-After",
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "X-RateLimit-Reset",
        "X-Request-Id",
      ],
      maxAge: SECONDS_PER_DAY,
    }),
  );

  // 全局错误处理——捕获所有 AppError 及未预期的错误
  app.onError((err, c) => {
    // 复用请求上下文的 request_id（由 requestContext 中间件注入），
    // 保证错误响应与服务端日志的 request_id 一致；缺失时兜底新生成。
    const requestId = (c.get("requestId") as string | undefined) ??
      crypto.randomUUID();
    if (err instanceof AppError) {
      err.requestId = requestId;
      if (err.code === "RATE_LIMITED") {
        const routePath =
          (c.req as unknown as { routePath?: string }).routePath;
        const route = normalizeMetricRoute(c.req.path, routePath);
        observabilityRegistry.inc("noj_http_rate_limited_total", {
          method: c.req.method,
          route,
        });
      }
      // 限流错误携带 X-RateLimit-* 响应头（issue #73）
      const extraHeaders =
        (err as { headers?: Record<string, string> }).headers;
      if (extraHeaders) {
        for (const [k, v] of Object.entries(extraHeaders)) {
          c.header(k, v);
        }
      }
      return c.json(
        {
          error: err.message,
          code: err.code,
          ...(err.meta ?? {}), // issue #102：透传 meta（如 USER_BANNED 的 reason/until）
          request_id: requestId,
        },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
      );
    }
    // request_id 由 logger 从请求上下文自动注入，无需重复传入
    logger.error("未处理的错误", { err });
    return c.json(
      {
        error: "服务器内部错误",
        code: "INTERNAL_ERROR",
        request_id: requestId,
      },
      500,
    );
  });

  // 全局中间件（PR-2 修复顺序问题）：
  // 注意：app.use() 的注册顺序决定执行顺序，必须在所有路由之前注册
  // 才能拦截请求。原 banlistMiddleware 注册在 routes 之后，存在顺序 bug。
  app.use("/api/v1/*", banlistMiddleware);
  app.use(
    "/api/v1/*",
    // shared 层不依赖业务域：维护开关读取器由组合根注入（实时读取，不缓存）。
    createMaintenanceMode(() => getSetting("maintenance_mode")?.value === true),
  );
  if (retireLegacyEndpoints) {
    // 只拦截 retired-endpoints.json 中列出的写方法；同路径 GET 深链接继续工作。
    app.use("/api/v1/*", retiredEndpointMiddleware());
  }
  app.route("/api/v1", internalLlmPolicyRouter);
  // 内部排空端点：必须位于维护中间件之后（中间件放行 /api/v1/internal/*）。
  // system 域不得跨域 import submission/observability，读取实现由组合根注入。
  app.route(
    "/api/v1",
    createInternalDrainRouter({
      getQueueHealth,
      readJudgeNodeReports: async () => {
        const redis = getRedis();
        if (redis.status !== "ready") return [];
        return await readJudgeNodeReports(redis);
      },
      judgeRequired: () => emptyJudgeSnapshot().required,
    }),
  );
  app.use("/api/v1/*", instanceAccessMiddleware);

  // 注册路由（按域自装配；各域 routes/index.ts 内部保持顺序敏感注释）
  app.route("/", createHealthRouter(observabilityRegistry));
  app.get("/metrics", async (c) => {
    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.body(await renderPrometheusMetrics(observabilityRegistry));
  });
  app.route("/api/v1", identityRouter);
  app.route("/api/v1", catalogRouter);
  app.route("/api/v1", submissionRouter);
  app.route("/api/v1", queryRouter);
  app.route("/api/v1", searchRouter);
  app.route("/api/v1", contestRouter);
  app.route("/api/v1", communityRouter);
  app.route("/api/v1", messagingRouter);
  app.route("/api/v1", systemRouter);
  app.route("/api/v1", legalRouter);
  app.route("/api/v1", workspaceRouter);
  app.route("/api/v1", domainProblemsRouter);
  app.route("/api/v1", domainTrainingsRouter);
  app.route("/api/v1", domainResourceManagementRouter);
  app.route("/api/v1", domainSubmissionsRouter);
  app.route("/api/v1", domainSubmissionJobsRouter);
  app.route("/api/v1", ownSubmissionHistoryRouter);
  app.route("/api/v1", domainSubmissionSse);
  app.route("/api/v1", domainObjectiveRouter);
  app.route("/api/v1", domainContestRouter);
  app.route("/api/v1", domainCommunityRouter);
  app.route("/api/v1", domainQueryRouter);
  app.route("/api/v1", domainStatsSse);
  app.route("/api/v1", domainSearchRouter);
  app.route("/api/v1", domainLlmRouter);
  app.route("/api/v1", educationRouter);
  app.route("/api/v1/admin", admin);
  // 评测镜像公开列表
  app.get("/api/v1/judge-images", async (c) => {
    const items = await listJudgeImages();
    return c.json({ data: items });
  });

  // SSE 的认证限定在事件路径，避免影响其他公开入口。
  app.route("/api/v1", submissionSse);
  app.route("/api/v1", accountNotificationRouter);

  return app;
}
