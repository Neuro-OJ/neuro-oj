import { createApp } from "./app.ts";
import { runMigrations } from "./db/migrate.ts";
import { connectRedis } from "./mq/connection.ts";
import { startResultConsumerWithRetry } from "./mq/consumer.ts";

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
  // 初始化数据库：迁移失败为致命错误，终止启动避免带病运行
  // （与 PR #63 ensureRootUser 的失败处理保持一致策略）
  try {
    await runMigrations();
  } catch (err) {
    console.error("数据库迁移失败，终止启动:", err);
    Deno.exit(1);
  }

  // 连接 Redis（共享连接供 producer 使用）
  // Redis 是评测分发依赖而非核心数据依赖，连接失败时仍启动 HTTP 服务，
  // 评测相关功能将通过健康检查暴露为 degraded。
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
