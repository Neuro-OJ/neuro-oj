import { Hono } from "hono";
import health from "./routes/health.ts";

/**
 * 创建并配置 Hono 应用实例。
 */
export function createApp(): Hono {
  const app = new Hono();

  // 注册路由
  app.route("/", health);

  return app;
}
