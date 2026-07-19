import { Hono } from "hono";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import health from "./routes/health.ts";
import auth from "./routes/auth.ts";
import admin from "./routes/admin.ts";
import categories from "./routes/categories.ts";
import problems from "./routes/problems.ts";
import checkin from "./routes/checkin.ts";
import queue from "./routes/queue.ts";
import submissions from "./routes/submissions.ts";
import users from "./routes/users.ts";
import rankings from "./routes/rankings.ts";
import conversations from "./routes/conversations.ts";
import search from "./routes/search.ts";
import { searchRateLimit } from "./middleware/searchRateLimit.ts";
import sse, { statsSse } from "./routes/sse.ts";
import { AppError } from "./lib/errors.ts";
import { logger } from "./lib/logging.ts";
import { listJudgeImages } from "./services/judge-images.ts";
import { banlistMiddleware } from "./middleware/banlist.ts";
import { requestContext } from "./middleware/request-context.ts";
import { getSetting } from "./services/system-settings.ts";

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
  // - 开发环境：允许所有来源（便于本地调试与第三方工具）
  // - 生产环境：从 CORS_ALLOWED_ORIGINS 环境变量读取白名单（逗号分隔）
  // - credentials: true 支持 noj-ui 通过 HTTP-only Cookie 携带认证信息
  const allowedOrigins = Deno.env.get("CORS_ALLOWED_ORIGINS")?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isProd = Deno.env.get("NOJ_ENV") === "production";

  app.use(
    "*",
    cors({
      origin: isProd
        ? (allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : []) // 生产环境未配置白名单则拒绝跨域
        : "*", // 开发环境允许所有
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      maxAge: 86400,
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
  app.route("/api/v1/categories", categories);
  app.route("/api/v1/problems", problems);
  app.route("/api/v1/checkin", checkin);
  app.route("/api/v1/queue", queue);
  app.route("/api/v1/submissions", submissions);
  app.route("/api/v1/users", users);
  app.route("/api/v1/rankings", rankings);
  app.route("/api/v1/conversations", conversations);
  app.use("/api/v1/search", searchRateLimit("anon"));
  app.route("/api/v1/search", search);
  // 评测镜像公开列表（必须在 sse 路由之前注册，避免被 SSE 的 authMiddleware 拦截）
  app.get("/api/v1/judge-images", async (c) => {
    const items = await listJudgeImages();
    return c.json({ data: items });
  });

  // 统计数据 SSE 端点（公开，无需 authMiddleware，必须在 sse 之前注册）
  app.route("/api/v1", statsSse);
  app.route("/api/v1", sse);

  return app;
}
