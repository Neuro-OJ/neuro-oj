import { createApp } from "./app.ts";
import { runMigrations } from "./db/migrate.ts";
import { connectRedis, createConsumerRedis } from "./mq/connection.ts";
import { startResultConsumerWithRetry } from "./mq/consumer.ts";
import { startJudgeRpcHandler } from "./mq/judge-rpc.ts";
import { initEventSubscriber } from "./lib/event-bus.ts";
import { snapshotEnv } from "./lib/env-snapshot.ts";
import { validateRegistry } from "./lib/settings-registry.ts";
import { ensureRootUser } from "./services/auth.ts";
import { getStorageProvider } from "./lib/storage/mod.ts";
import { initSystemSettings } from "./services/system-settings.ts";

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
 * 检查邮件 Provider 环境变量配置。
 *
 * 非致命校验：配置缺失时降级到 mock 并输出警告，不阻塞启动。
 * 用于提示运维人员完善邮件配置。
 */
function checkEmailProviderConfig(): void {
  const provider = Deno.env.get("EMAIL_PROVIDER") || "mock";

  if (provider === "aliyun") {
    const missing = [
      "ALIBABA_ACCESS_KEY_ID",
      "ALIBABA_ACCESS_KEY_SECRET",
      "ALIBABA_FROM_EMAIL",
    ].filter((k) => !Deno.env.get(k));

    if (missing.length > 0) {
      console.warn(
        `[email] EMAIL_PROVIDER=aliyun 但缺少环境变量: ${
          missing.join(", ")
        }，降级到 mock`,
      );
      Deno.env.set("EMAIL_PROVIDER", "mock");
    }
  } else if (provider === "tencent") {
    const missing = [
      "TENCENT_SECRET_ID",
      "TENCENT_SECRET_KEY",
      "TENCENT_FROM_EMAIL",
      "TENCENT_REGION",
    ].filter((k) => !Deno.env.get(k));

    if (missing.length > 0) {
      console.warn(
        `[email] EMAIL_PROVIDER=tencent 但缺少环境变量: ${
          missing.join(", ")
        }，降级到 mock`,
      );
      Deno.env.set("EMAIL_PROVIDER", "mock");
    }
  }
}

/**
 * 应用启动入口。
 * 初始化顺序：
 * 1. JWT_SECRET 强度校验（启动期致命错误）
 * 2. 数据库迁移
 * 3. 邮件 Provider 配置检查（非致命，降级到 mock）
 * 4. Redis 连接验证
 * 5. 启动评测结果消费者（后台）
 * 6. 启动 HTTP 服务
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

  // 确保 root 系统用户存在（必需依赖，失败时终止启动）
  try {
    await ensureRootUser();
  } catch (err) {
    console.error("Root 用户创建失败，终止启动:", err);
    Deno.exit(1);
  }

  // 校验系统设置注册表（issue #99）
  // 启动期检查：key 唯一、type 合法。开发期就发现问题。
  try {
    validateRegistry();
  } catch (err) {
    console.error("系统设置注册表校验失败，终止启动:", err);
    Deno.exit(1);
  }

  // 初始化系统设置缓存（issue #99）
  // 从 system_settings 全量加载到内存 Map，失败时终止启动。
  try {
    await initSystemSettings();
  } catch (err) {
    console.error("系统设置缓存初始化失败，终止启动:", err);
    Deno.exit(1);
  }

  // 启动期 env 快照（issue #99）
  // 一次性读取 env-only 设置项到内存 Map，admin 面板只读展示。
  snapshotEnv();

  // 邮件 Provider 配置检查（非致命，配置缺失时降级到 mock）
  checkEmailProviderConfig();

  // 存储 Provider 初始化（非致命，S3 bucket 创建失败仅 warn）
  try {
    const storage = await getStorageProvider();
    if (typeof storage.ensureBucket === "function") {
      await storage.ensureBucket();
    }
  } catch (err) {
    console.warn(
      "[storage] 存储 Provider 初始化失败:",
      err instanceof Error ? err.message : String(err),
    );
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

  // 启动 Judge RPC 处理器（响应 judge 的镜像白名单等请求）
  const redisForRpc = createConsumerRedis();
  try {
    await redisForRpc.connect();
  } catch (err) {
    console.error("Judge RPC Redis 连接失败:", err);
  }
  // deno-lint-ignore no-explicit-any
  startJudgeRpcHandler(redisForRpc as any);

  // 初始化 Redis Pub/Sub 事件订阅者（后台运行，用于 SSE 推送）
  initEventSubscriber();

  // 启动 HTTP 服务
  Deno.serve({ port }, app.fetch);

  console.log(`noj-core running on http://localhost:${port}`);
}

await main();
