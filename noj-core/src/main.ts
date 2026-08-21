import { createApp } from "./app.ts";
import { closeDbForShutdown } from "./db/connection.ts";
import { runMigrations } from "./db/migrate.ts";
import { startQueueSweeper } from "./mq/sweeper.ts";
import { closeRedisForShutdown, connectRedis } from "./mq/connection.ts";
import {
  requestResultConsumerShutdown,
  startResultConsumerWithRetry,
} from "./mq/consumer.ts";
import { initEventSubscriber } from "./lib/event-bus.ts";
import { snapshotEnv } from "./lib/env-snapshot.ts";
import { validateRegistry } from "./lib/settings-registry.ts";
import { ensureRootUser } from "./services/auth.ts";
import { ensureRbacSeeds } from "./services/seed/seed-rbac.ts";
import { getStorageProvider } from "./lib/storage/mod.ts";
import { getSetting, initSystemSettings } from "./services/system-settings.ts";
import { startAuditLogRetentionTask } from "./services/audit-log.ts";
import { logger } from "./lib/logging.ts";
import { MIN_JWT_SECRET_LENGTH } from "./lib/constants.ts";

const app = createApp();

const port = parseInt(Deno.env.get("PORT") || "8000", 10);

/**
 * 检查邮件 Provider 运行时配置。
 *
 * 非致命校验：配置缺失时降级到 mock 并输出警告，不阻塞启动。
 * 因 email provider 凭证已迁移为 DB-backed 设置项，
 * 此函数仅作启动期警告提示，不再修改 provider 选择。
 */
function checkEmailProviderConfig(): void {
  const pSetting = getSetting("email_provider");
  const provider = typeof pSetting?.value === "string"
    ? pSetting.value
    : "mock";

  if (provider === "aliyun") {
    const missing = [];
    for (
      const [key, label] of [
        ["alibaba_access_key_id", "ALIBABA_ACCESS_KEY_ID"],
        ["alibaba_access_key_secret", "ALIBABA_ACCESS_KEY_SECRET"],
        ["alibaba_from_email", "ALIBABA_FROM_EMAIL"],
      ]
    ) {
      const setting = getSetting(key);
      if (!(typeof setting?.value === "string" && setting.value.length > 0)) {
        missing.push(label);
      }
    }
    if (missing.length > 0) {
      logger.warn("email_provider=aliyun 但缺少配置", {
        provider: "aliyun",
        missing: missing.join(", "),
        hint: "可通过管理后台 > 系统设置配置",
      });
    }
  } else if (provider === "tencent") {
    const missing = [];
    for (
      const [key, label] of [
        ["tencent_secret_id", "TENCENT_SECRET_ID"],
        ["tencent_secret_key", "TENCENT_SECRET_KEY"],
        ["tencent_from_email", "TENCENT_FROM_EMAIL"],
        ["tencent_region", "TENCENT_REGION"],
      ]
    ) {
      const setting = getSetting(key);
      if (!(typeof setting?.value === "string" && setting.value.length > 0)) {
        missing.push(label);
      }
    }
    if (missing.length > 0) {
      logger.warn("email_provider=tencent 但缺少配置", {
        provider: "tencent",
        missing: missing.join(", "),
        hint: "可通过管理后台 > 系统设置配置",
      });
    }
  }
}

/**
 * 应用启动入口。
 * 初始化顺序：
 * 1. JWT_SECRET 强度校验（启动期致命错误）
 * 2. 生产环境 TRUSTED_PROXIES 校验（启动期致命错误，PR-7）
 * 3. 数据库迁移
 * 4. 邮件 Provider 配置检查（非致命，降级到 mock）
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

  // PR-7 / NOJ-031：TRUSTED_PROXIES 生产校验必须在 initSystemSettings() 之后执行，
  // 与运行时 getTrustedProxies() 共用 system_settings 数据源，避免读空缓存误杀启动。
  if (Deno.env.get("NOJ_ENV") === "production") {
    const trustedProxiesSetting = getSetting("trusted_proxies");
    const trustedProxiesValue = typeof trustedProxiesSetting?.value ===
        "string"
      ? trustedProxiesSetting.value
      : "";
    if (!trustedProxiesValue || trustedProxiesValue.trim() === "") {
      logger.error(
        "TRUSTED_PROXIES 未配置。\n" +
          "生产环境（NOJ_ENV=production）必须显式配置可信代理白名单，\n" +
          "否则 X-Forwarded-For 首项可被攻击者伪造以绕过 IP 限流和 IP 黑名单。\n" +
          "配置方式：通过管理后台 → 系统设置 → trusted_proxies 项（DB-backed）。\n" +
          "格式：逗号分隔的 IP 或 CIDR，如 `10.0.0.0/8,192.168.1.1`。",
      );
      Deno.exit(1);
    }
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
  startResultConsumerWithRetry();

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
