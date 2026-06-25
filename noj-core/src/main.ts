import { createApp } from "./app.ts";
import { runMigrations } from "./db/migrate.ts";
import { connectRedis } from "./mq/connection.ts";
import { startResultConsumerWithRetry } from "./mq/consumer.ts";

const app = createApp();

const port = parseInt(Deno.env.get("PORT") || "8000", 10);

/**
 * JWT 签名密钥最小长度（字符数）。
 *
 * HS256 算法要求密钥至少 256 bit（32 字节），不足则降低 token 防伪造强度，
 * 存在被暴力破解的理论风险。OWASP 2025+ 建议密钥强度不低于此阈值。
 */
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * 应用启动入口。
 * 初始化顺序：
 * 1. JWT_SECRET 强度校验（启动期致命错误）
 * 2. 数据库迁移
 * 3. Redis 连接验证
 * 4. 启动评测结果消费者（后台）
 * 5. 启动 HTTP 服务
 */
async function main() {
  // JWT 启动校验：HS256 要求至少 256 bit（32 字节）密钥强度
  // 修复 issue 64 评论 §5.2：默认 .env 模板是 27 字符，低于安全阈值
  const jwtSecret = Deno.env.get("JWT_SECRET");
  if (!jwtSecret || jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    const actualLength = jwtSecret ? jwtSecret.length : 0;
    console.error(
      `JWT_SECRET 未设置或长度不足（当前 ${actualLength} 字符，需要至少 ${MIN_JWT_SECRET_LENGTH} 字符）。\n` +
        `HS256 算法要求至少 256 bit 密钥强度，使用弱密钥会显著降低 token 防伪造能力。\n` +
        `可通过 \`openssl rand -base64 48\` 生成强随机密钥。`,
    );
    Deno.exit(1);
  }

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
