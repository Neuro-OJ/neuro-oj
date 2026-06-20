import { Hono } from "hono";
import health from "./routes/health.ts";
import auth, { adminAuth } from "./routes/auth.ts";
import categories from "./routes/categories.ts";
import problems from "./routes/problems.ts";
import submissions, { adminSubmissions } from "./routes/submissions.ts";
import { AppError } from "./lib/errors.ts";

/**
 * 创建并配置 Hono 应用实例。
 */
export function createApp(): Hono {
  const app = new Hono();

  // 全局错误处理——捕获所有 AppError 及未预期的错误
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { error: err.message },
        err.statusCode as 400 | 401 | 404 | 409 | 500,
      );
    }
    console.error("未处理的错误:", err);
    return c.json({ error: "服务器内部错误" }, 500);
  });

  // 注册路由
  app.route("/", health);
  app.route("/api/v1/auth", auth);
  app.route("/api/v1/admin", adminAuth);
  app.route("/api/v1/categories", categories);
  app.route("/api/v1/problems", problems);
  app.route("/api/v1/submissions", submissions);
  app.route("/api/v1/admin/submissions", adminSubmissions);

  return app;
}
