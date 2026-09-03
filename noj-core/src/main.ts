import { createApp } from "./app.ts";
import { closeDbForShutdown } from "./shared/db/connection.ts";
import { runMigrations } from "./shared/db/migrate.ts";
import { startQueueSweeper } from "./mq/sweeper.ts";
import { closeRedisForShutdown, connectRedis } from "./shared/mq/connection.ts";
import {
  requestResultConsumerShutdown,
  startResultConsumerWithRetry,
} from "./mq/consumer.ts";
import { initEventSubscriber } from "./shared/sse/event-bus.ts";
import { snapshotEnv } from "./lib/env-snapshot.ts";
import { validateRegistry } from "./shared/config/settings-registry.ts";
import { createReviewConsumer } from "./mq/review-consumer.ts";
import { ensureRootUser } from "./domains/identity/index.ts";
import { ensureRbacSeeds } from "./domains/system/index.ts";
import { getStorageProvider } from "./lib/storage/mod.ts";
import { getSetting, initSystemSettings } from "./domains/system/index.ts";
import { startAuditLogRetentionTask } from "./domains/system/index.ts";
import { logger } from "./shared/base/logging.ts";
import {
  assertProductionConfig,
  type ProductionConfig,
} from "./shared/config/production-config.ts";
import {
  MIN_JWT_SECRET_LENGTH,
  MIN_TFA_ENCRYPTION_KEY_LENGTH,
} from "./shared/base/constants.ts";

const app = createApp();

const port = parseInt(Deno.env.get("PORT") || "8000", 10);

function configuredSetting(key: string): string | undefined {
  const setting = getSetting(key);
  return typeof setting?.value === "string" && setting.value.length > 0
    ? setting.value
    : undefined;
}

function buildProductionConfig(): ProductionConfig {
  return {
    environment: Deno.env.get("NOJ_ENV"),
    databaseUrl: Deno.env.get("DATABASE_URL"),
    redisUrl: Deno.env.get("REDIS_URL"),
    jwtSecret: Deno.env.get("JWT_SECRET"),
    tfaEncryptionKey: Deno.env.get("TFA_ENCRYPTION_KEY"),
    adminEmail: Deno.env.get("ADMIN_EMAIL"),
    adminPassword: Deno.env.get("ADMIN_PASS"),
    appUrl: Deno.env.get("APP_URL"),
    corsAllowedOrigins: Deno.env.get("CORS_ALLOWED_ORIGINS"),
    allowInsecureHttp: Deno.env.get("NOJ_ALLOW_INSECURE_HTTP") === "true",
    trustedProxies: configuredSetting("trusted_proxies"),
    emailProvider: configuredSetting("email_provider"),
    emailSettings: {
      alibaba_access_key_id: configuredSetting("alibaba_access_key_id"),
      alibaba_access_key_secret: configuredSetting("alibaba_access_key_secret"),
      alibaba_from_email: configuredSetting("alibaba_from_email"),
      tencent_secret_id: configuredSetting("tencent_secret_id"),
      tencent_secret_key: configuredSetting("tencent_secret_key"),
      tencent_from_email: configuredSetting("tencent_from_email"),
      tencent_region: configuredSetting("tencent_region"),
    },
    storageProvider: configuredSetting("storage_provider"),
    s3Endpoint: configuredSetting("s3_endpoint"),
    s3AccessKey: configuredSetting("s3_access_key"),
    s3SecretKey: configuredSetting("s3_secret_key"),
    s3Bucket: configuredSetting("s3_bucket"),
  };
}

/**
 * 应用启动入口。
 * 初始化顺序：
 * 1. JWT_SECRET 强度校验（启动期致命错误）
 * 2. TFA 密钥强度校验（启动期致命错误）
 * 3. 数据库迁移、Root/RBAC 和系统设置初始化
 * 4. 生产配置校验
 * 5. Redis 连接验证
 * 6. 启动评测结果消费者（后台）
 * 7. 启动 HTTP 服务
 */
/**
 * 致命启动步骤：失败则记录错误并终止启动（避免带病运行）。
 */
async function fatalStep(
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.error(`${name}失败，终止启动`, { err });
    Deno.exit(1);
  }
}

async function main() {
  // JWT 启动校验：HS256 要求至少 256 bit（32 字节）密钥强度
  // 修复 issue 64 评论 §5.2：默认 .env 模板是 27 字符，低于安全阈值
  const jwtSecret = Deno.env.get("JWT_SECRET");
  if (!jwtSecret || jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    const actualLength = jwtSecret ? jwtSecret.length : 0;
    logger.error(
      `JWT_SECRET 未设置或长度不足（当前 ${actualLength} 字符，需要至少 ${MIN_JWT_SECRET_LENGTH} 字符）。\n` +
        `HS256 算法要求至少 256 bit 密钥强度，使用弱密钥会显著降低 token 防伪造能力。\n` +
        `可通过 \`openssl rand -base64 48\` 生成强随机密钥。`,
    );
    Deno.exit(1);
  }

  // TFA 加密密钥启动校验（fail-fast，评审 P2 修复）：
  // TFA_ENCRYPTION_KEY 用于 AES-256-GCM 加密 TOTP secret，缺失/过短时
  // 必须拒绝启动。否则 setup 请求会返回 500，或密钥丢失后已启用 TFA 的
  // 用户无法登录（secret 无法解密）。
  const tfaKey = Deno.env.get("TFA_ENCRYPTION_KEY");
  if (!tfaKey || tfaKey.length < MIN_TFA_ENCRYPTION_KEY_LENGTH) {
    const actualLength = tfaKey ? tfaKey.length : 0;
    logger.error(
      `TFA_ENCRYPTION_KEY 未设置或长度不足（当前 ${actualLength} 字符，需要至少 ${MIN_TFA_ENCRYPTION_KEY_LENGTH} 字符）。\n` +
        `TFA_ENCRYPTION_KEY 是 TOTP secret 的 AES-256-GCM 加密密钥，必须独立于 JWT_SECRET 配置。\n` +
        `可通过 \`openssl rand -base64 48\` 生成强随机密钥。`,
    );
    Deno.exit(1);
  }

  // 初始化数据库：迁移失败为致命错误，终止启动避免带病运行
  // （与 PR #63 ensureRootUser 的失败处理保持一致策略）
  await fatalStep("数据库迁移", () => runMigrations());

  // 确保 root 系统用户存在（必需依赖，失败时终止启动）
  await fatalStep("Root 用户创建", () => ensureRootUser());

  // 初始化 RBAC 种子数据（幂等）
  await fatalStep("RBAC 种子数据初始化", () => ensureRbacSeeds());

  // 校验系统设置注册表（issue #99）
  // 启动期检查：key 唯一、type 合法。开发期就发现问题。
  await fatalStep("系统设置注册表校验", () => validateRegistry());

  // 初始化系统设置缓存（issue #99）
  // 从 system_settings 全量加载到内存 Map，失败时终止启动。
  await fatalStep("系统设置缓存初始化", () => initSystemSettings());

  // 启动期 env 快照（issue #99）
  // 一次性读取 env-only 设置项到内存 Map，admin 面板只读展示。
  snapshotEnv();

  // Issue #330：生产配置必须在 HTTP 监听前完成 fail-fast 校验。
  await fatalStep("生产配置校验", () => {
    assertProductionConfig(buildProductionConfig());
  });

  // 存储 Provider 初始化（非致命，S3 bucket 创建失败仅 warn）
  try {
    const storage = await getStorageProvider();
    if (typeof storage.ensureBucket === "function") {
      await storage.ensureBucket();
    }
  } catch (err) {
    logger.warn("存储 Provider 初始化失败", { err });
  }

  // 连接 Redis（共享连接供 producer 使用）
  // Redis 是评测分发依赖而非核心数据依赖，连接失败时仍启动 HTTP 服务，
  // 评测相关功能将通过健康检查暴露为 degraded。
  try {
    await connectRedis();
  } catch (err) {
    logger.error("Redis 连接失败，评测分发功能不可用", { err });
  }

  // 启动评测结果消费者（后台运行，带自动重连，不阻塞 HTTP）
  void startResultConsumerWithRetry();

  // 启动私信异步内容审核消费者（issue #413；Redis 不可用时自动重试，不阻断启动）
  void createReviewConsumer()();

  // 启动 processing 超时重投 + pending 提交恢复 sweeper
  startQueueSweeper();

  // 初始化 Redis Pub/Sub 事件订阅者（后台运行，用于 SSE 推送）
  initEventSubscriber();

  // 启动 HTTP 服务（保留 server 句柄用于优雅关闭）
  const server = Deno.serve({ port }, app.fetch);

  logger.info("noj-core 已启动", { url: `http://localhost:${port}` });

  // 启动后台审计日志保留任务
  startAuditLogRetentionTask();

  // NOJ-030：监听 SIGTERM/SIGINT，先停止接收新请求并排空，再关闭 Redis/DB。
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("收到关闭信号，开始优雅关闭", { signal });

    try {
      requestResultConsumerShutdown();
      // SSE 等长连接可能让 shutdown() 一直等待；加一个兜底超时，
      // 超时后继续关闭资源并退出，避免被 K8s SIGKILL 前卡死。
      await Promise.race([
        server.shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ]);
      logger.info("HTTP 服务已停止接收新请求并完成排空");
    } catch (err) {
      logger.warn("HTTP 优雅关闭失败", { err });
    }

    await Promise.allSettled([
      closeRedisForShutdown(),
      closeDbForShutdown(),
    ]);
    logger.info("资源已清理，进程退出");
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
  });
  Deno.addSignalListener("SIGINT", () => {
    void gracefulShutdown("SIGINT");
  });
}

await main();
