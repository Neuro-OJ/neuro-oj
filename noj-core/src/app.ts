import { Hono } from "hono";
import health from "./routes/health.ts";
import problems from "./routes/problems.ts";
import submissions from "./routes/submissions.ts";
import { initSampleProblems } from "./services/problems.ts";

/**
 * 创建并配置 Hono 应用实例。
 */
export function createApp(): Hono {
  const app = new Hono();

  // 初始化示例数据
  initSampleProblems();

  // 注册路由
  app.route("/", health);
  app.route("/api/v1/problems", problems);
  app.route("/api/v1/submissions", submissions);

  return app;
}
