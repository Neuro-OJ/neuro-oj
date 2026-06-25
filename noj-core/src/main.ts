import { createApp } from "./app.ts";
import { runMigrations } from "./db/migrate.ts";
import { connectRedis } from "./mq/connection.ts";
import { startResultConsumerWithRetry } from "./mq/consumer.ts";
import { ensureRootUser } from "./services/auth.ts";

const app = createApp();

const port = parseInt(Deno.env.get("PORT") || "8000", 10);

/**
 * 应用启动入口。
 * 初始化顺序：
 * 1. 数据库迁移
 * 2. Redis 连接验证
 * 3. 启动评测结果消费者（后台）
 * 4. 启动 HTTP 服务
 */
async function main() {
  // 初始化数据库
  try {
    await runMigrations();
  } catch (err) {
    console.error("数据库初始化失败，服务可能不完整:", err);
  }

  // 确保 root 系统用户存在（必需依赖，失败时终止启动）
  try {
    await ensureRootUser();
  } catch (err) {
    console.error("Root 用户创建失败，终止启动:", err);
    Deno.exit(1);
  }

  // 连接 Redis（共享连接供 producer 使用）
  try {
    await connectRedis();
  } catch (err) {
    console.error("Redis 连接失败，评测分发功能不可用:", err);
  }

  // 启动评测结果消费者（后台运行，带自动重连，不阻塞 HTTP）
  startResultConsumerWithRetry();

  // 启动 HTTP 服务
  Deno.serve({ port }, app.fetch);

  console.log(`noj-core running on http://localhost:${port}`);
}

await main();
