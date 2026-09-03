import { Hono } from "hono";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import health from "./routes/health.ts";
import stats from "./domains/query/routes/stats.ts";
import auth from "./domains/identity/routes/auth.ts";
import admin from "./routes/admin/index.ts";
import adminAnnouncements from "./domains/system/routes/admin-announcements.ts";
import adminTrainings from "./domains/catalog/routes/admin-trainings.ts";
import tags from "./domains/catalog/routes/tags.ts";
import problems from "./domains/catalog/routes/problems.ts";
import checkin from "./domains/identity/routes/checkin.ts";
import queue from "./domains/submission/routes/queue.ts";
import submissions from "./domains/submission/routes/submissions.ts";
import selfTests from "./domains/submission/routes/self-tests.ts";
import users from "./domains/identity/routes/users.ts";
import rankings from "./domains/query/routes/rankings.ts";
import conversations from "./domains/messaging/routes/conversations.ts";
import community from "./domains/community/routes/community.ts";
import communityAdmin from "./domains/community/routes/community-admin.ts";
import search from "./domains/query/routes/search.ts";
import contests from "./domains/contest/routes/contests.ts";
import trainings from "./domains/catalog/routes/trainings.ts";
import announcements from "./domains/system/routes/announcements.ts";
import sse, { contestSse, statsSse } from "./routes/sse.ts";
import { AppError } from "./shared/base/errors.ts";
import { logger } from "./shared/base/logging.ts";
import { listJudgeImages } from "./domains/system/index.ts";
import { banlistMiddleware } from "./middleware/banlist.ts";
import { requestContext } from "./shared/middleware/request-context.ts";
import { getSetting } from "./domains/system/index.ts";
import { SECONDS_PER_DAY } from "./shared/base/constants.ts";

/**
 * 维护模式中间件（PR-2 死开关）。
 *
 * 当 `maintenance_mode=true` 时：
 * - GET/HEAD/OPTIONS 请求放行（用户仍可浏览、查状态）
 * - POST/PUT/PATCH/DELETE 请求返 503 + `MAINTENANCE` code
 *
 * 设计取舍：
 * - 不缓存 maintenance_mode：管理后台切换后下一次请求立即生效
 * - 不阻塞 /health：负载均衡器仍能正常探活
 */
function maintenanceMode(
  c: Context,
  next: Next,
): Promise<Response | void> {
  const setting = getSetting("maintenance_mode");
  if (setting?.value !== true) {
    return next();
  }

  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }

  return Promise.resolve(
    c.json(
      {
        error: "系统维护中，请稍后再试",
        code: "MAINTENANCE",
      },
      503,
    ),
  );
}

/**
 * 创建并配置 Hono 应用实例。
 */
export function createApp(): Hono {
  const app = new Hono();

  // 请求上下文中间件（最外层）：为每个请求生成 request_id，
  // 写入 context 供 onError 复用，并包裹后续处理使日志自动带 request_id。
  app.use("*", requestContext);

  // CORS 中间件
  // - 开发环境：只允许本地 UI 开发端口，避免 credentials 与通配来源组合
  // - 生产环境：从 CORS_ALLOWED_ORIGINS 环境变量读取白名单（逗号分隔）
  // - credentials: true 支持 noj-ui 通过 HTTP-only Cookie 携带认证信息
  const allowedOrigins = Deno.env.get("CORS_ALLOWED_ORIGINS")?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isProd = Deno.env.get("NOJ_ENV") === "production";
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
      allowHeaders: ["Content-Type", "Authorization"],
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
  app.use("/api/v1/*", maintenanceMode);

  // 注册路由
  app.route("/", health);
  app.route("/api/v1/auth", auth);
  app.route("/api/v1/admin", admin);
  // 公告管理：细粒度权限（admin:full_access 通配放行 或 announcement:manage），
  // 独立于 admin 实例（admin 实例组级 adminMiddleware 仅放行 full_access）
  app.route("/api/v1/admin/announcements", adminAnnouncements);
  app.route("/api/v1/admin/trainings", adminTrainings);
  app.route("/api/v1/tags", tags);
  app.route("/api/v1/problems", problems);
  app.route("/api/v1/checkin", checkin);
  app.route("/api/v1/queue", queue);
  app.route("/api/v1/submissions", submissions);
  app.route("/api/v1", selfTests);
  app.route("/api/v1/users", users);
  app.route("/api/v1/rankings", rankings);
  app.route("/api/v1/conversations", conversations);
  app.route("/api/v1/community", community);
  // 社区管理路由（/api/v1/community/admin/*）：独立 router，组级
  // requireCommunityModeration 守卫集中在 community-admin.ts 顶部
  app.route("/api/v1/community", communityAdmin);
  app.route("/api/v1/contests", contests);
  app.route("/api/v1/trainings", trainings);
  app.route("/api/v1/search", search);
  // 公告公开路由：必须在 sse 之前注册——sse 实例的全局 authMiddleware
  // 会拦截所有挂载在其后的路由；公告 SSE 端点 /announcements/events
  // 注册在本实例内（announcements.ts），位于 /:id 参数路由之前
  app.route("/api/v1/announcements", announcements);
  // 评测镜像公开列表（必须在 sse 路由之前注册，避免被 SSE 的 authMiddleware 拦截）
  app.get("/api/v1/judge-images", async (c) => {
    const items = await listJudgeImages();
    return c.json({ data: items });
  });

  // 公开站点统计（关于页数据面板，无鉴权，同样必须在 sse 之前注册）
  app.route("/api/v1", stats);

  // 统计数据 SSE 端点（公开，无需 authMiddleware，必须在 sse 之前注册）
  app.route("/api/v1", statsSse);
  app.route("/api/v1", contestSse);
  app.route("/api/v1", sse);

  return app;
}
