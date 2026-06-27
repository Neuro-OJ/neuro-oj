import { Hono } from "hono";
import { cors } from "hono/cors";
import health from "./routes/health.ts";
import auth, { adminAuth } from "./routes/auth.ts";
import categories from "./routes/categories.ts";
import problems from "./routes/problems.ts";
import queue from "./routes/queue.ts";
import submissions, { adminSubmissions } from "./routes/submissions.ts";
import users from "./routes/users.ts";
import { AppError } from "./lib/errors.ts";

/**
 * 创建并配置 Hono 应用实例。
 */
export function createApp(): Hono {
  const app = new Hono();

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
    // 为每次错误生成 request_id，便于客户端报错时与服务端日志关联
    const requestId = crypto.randomUUID();
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
          request_id: requestId,
        },
        err.statusCode as 400 | 401 | 404 | 409 | 429 | 500,
      );
    }
    console.error("未处理的错误 [request_id=" + requestId + "]:", err);
    return c.json(
      {
        error: "服务器内部错误",
        code: "INTERNAL_ERROR",
        request_id: requestId,
      },
      500,
    );
  });

  // 注册路由
  app.route("/", health);
  app.route("/api/v1/auth", auth);
  app.route("/api/v1/admin", adminAuth);
  app.route("/api/v1/categories", categories);
  app.route("/api/v1/problems", problems);
  app.route("/api/v1/queue", queue);
  app.route("/api/v1/submissions", submissions);
  app.route("/api/v1/admin/submissions", adminSubmissions);
  app.route("/api/v1/users", users);

  return app;
}
