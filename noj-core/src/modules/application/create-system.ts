import { createApp } from "../../app.ts";
import { closeDbForShutdown, getDb } from "../../shared/db/connection.ts";
import { startQueueSweeper } from "../evaluations/mq/sweeper.ts";
import { startResultConsumerPool } from "../evaluations/mq/consumer.ts";
import { startSubmissionJobWorker } from "../evaluations/services/versioning/dispatch-job-item.ts";
import {
  closeRedisForShutdown,
  connectRedis,
} from "../../shared/mq/connection.ts";
import { createManagedTaskGroup } from "../../shared/runtime/managed-task.ts";
import {
  performShutdown,
  type ShutdownHttp,
} from "../../shared/runtime/shutdown.ts";
import { migrateLegacyJudgeQueue } from "../evaluations/mq/legacy-judge-queue.ts";
import { migratePoolJudgeQueues } from "../evaluations/mq/pool-judge-queue.ts";
import { initEventSubscriber } from "../../shared/sse/event-bus.ts";
import { startSseEventRetentionTask } from "../../shared/sse/sse-events.ts";
import { createSseStreamScope } from "../../shared/sse/sse-stream.ts";
import { snapshotEnv } from "../platform/services/env-snapshot.ts";
import { validateRegistry } from "../../shared/config/settings-registry.ts";
import { startReviewConsumer } from "../communication/review/mq/review-consumer.ts";
import { startSearchIndexConsumer } from "../read-models/search/consumer/search-index-consumer.ts";
import {
  startEducationEmailWorker,
  startEducationPublishingWorker,
} from "../education/services/worker-lifecycle.ts";
import {
  EDUCATION_OUTBOX_MIGRATION_BATCH,
  type EducationOutboxMigrationCursor,
  migrateEducationOutboxTx,
} from "../education/contracts/outbox-migration.ts";
import { startTaskWorker } from "../runtime/tasks/worker.ts";
import { createBackgroundHandlers } from "./background-handlers.ts";
import { getStorageProvider } from "../assets/storage/mod.ts";
import { startDomainStorageReconciliation } from "../assets/services/domain-reconciliation.ts";
import { getEmailConfigStatus } from "../platform/system/services/email-status.ts";
import {
  getSetting,
  initSystemSettings,
  listOrphanedBootstrapRows,
  listRuntimeEnvConflicts,
  registerSettingsInvalidationListener,
} from "../platform/services/system-settings.ts";
import { startAuditLogRetentionTask } from "../platform/services/audit-log.ts";
import { describeLlmPlatformDefaultGap } from "../platform/gateway/services/llm.ts";
import { getLogger } from "@logtape/logtape";
import { describePlaceholderSecret } from "../../shared/security/secret-placeholders.ts";

const logger = getLogger(["noj", "core"]);
import {
  assertProductionConfig,
  type ProductionConfig,
} from "../../shared/config/production-config.ts";
import {
  MIN_JWT_SECRET_LENGTH,
  MIN_TFA_ENCRYPTION_KEY_LENGTH,
} from "../../shared/base/constants.ts";
import { assertSchemaCompatible } from "../../shared/db/schema-compat.ts";

// 每次 Core 装配拥有独立的 SSE 流 scope：通过 createApp 显式注入，关闭时据此
// 同步结束所有已建立长连接，让 server.shutdown() 能完成排空。连接只存在于当前
// 进程，多副本需各自关闭自己的 scope。
const sseStreams = createSseStreamScope();
const app = createApp({ sseStreamScope: sseStreams });

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

/** 启动时把旧教学事实幂等映射到通用任务；不标记旧行完成，完成仍由 handler 负责。 */
async function migrateEducationOutboxAtStartup(): Promise<void> {
  let cursor: EducationOutboxMigrationCursor | undefined;
  let migrated = 0;
  for (let batchNo = 0; batchNo < 100_000; batchNo++) {
    const result = await getDb().transaction((tx) =>
      migrateEducationOutboxTx(tx, EDUCATION_OUTBOX_MIGRATION_BATCH, cursor)
    );
    migrated += result.items.length;
    if (!result.nextCursor || result.items.length === 0) break;
    cursor = result.nextCursor;
    if (result.remaining === 0) break;
    if (batchNo === 99_999) {
      throw new Error("教学 outbox 迁移超过批次数上限");
    }
  }
  if (migrated > 0) {
    logger.info("教学 outbox 已迁入通用后台任务", { migrated });
  }
}

/**
 * 应用启动入口。
 * 初始化顺序：
 * 1. JWT_SECRET 强度校验（启动期致命错误）
 * 2. TFA 密钥强度校验（启动期致命错误）
 * 3. 只读 schema 兼容检查与系统设置加载
 * 4. 生产配置校验
 * 5. Redis 连接验证
 * 6. 启动评测结果消费者（后台）
 * 7. 启动 HTTP 服务
 *
 * 迁移和系统种子属于显式 `noj db migrate` / `noj init system`，HTTP
 * 启动绝不执行 DDL 或隐式初始化。
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
    logger.error("{name}失败，终止启动", { name, err });
    throw new Error(`启动步骤失败：${name}`, { cause: err });
  }
}

/** 启动 Core；仅由 `src/main.ts` 调用，避免导入组合根时隐式启动进程。 */
export async function startCore() {
  // 所有依赖检查和装配都在同一个回滚边界内。即使 schema/config 检查在 HTTP
  // 监听前失败，前面已经创建的 PostgreSQL/Redis 句柄也必须经过统一关闭，不能
  // 由 fatalStep 直接 Deno.exit 绕过清理。
  const backgroundTasks = createManagedTaskGroup();
  const shutdownResources = [
    { name: "redis", close: () => closeRedisForShutdown() },
    { name: "database", close: () => closeDbForShutdown() },
  ];
  const noHttp: ShutdownHttp = { name: "http-server", shutdown: () => {} };
  let server: ReturnType<typeof Deno.serve> | undefined;

  try {
    // JWT 启动校验：HS256 要求至少 256 bit（32 字节）密钥强度
    // 修复 issue 64 评论 §5.2：默认 .env 模板是 27 字符，低于安全阈值
    const jwtSecret = Deno.env.get("JWT_SECRET");
    if (!jwtSecret || jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
      const actualLength = jwtSecret ? jwtSecret.length : 0;
      logger.error(
        "JWT_SECRET 未设置或长度不足（当前 {actual} 字符，需要至少 {min} 字符）。\n" +
          "HS256 算法要求至少 256 bit 密钥强度，使用弱密钥会显著降低 token 防伪造能力。\n" +
          "可通过 `openssl rand -base64 48` 生成强随机密钥。",
        { actual: actualLength, min: MIN_JWT_SECRET_LENGTH },
      );
      throw new Error("JWT_SECRET 未设置或长度不足，拒绝启动");
    }
    // 占位值校验（2026-09-12 架构评审 §2.4）：
    // `.env.prod.example` 的 `change-me-to-a-random-string-at-least-32-chars`
    // 长度 46，仅靠长度校验会被放行；compose 的 `${JWT_SECRET:?}` 也只拦空值。
    // 于是"照文档复制模板后直接部署"会以**公开已知的密钥**上线 → 可伪造任意用户 token。
    const jwtPlaceholder = describePlaceholderSecret("JWT_SECRET", jwtSecret);
    if (jwtPlaceholder) {
      logger.error(
        "{reason}。\n" +
          "请不要直接使用示例/占位密钥；可通过 `openssl rand -base64 48` 生成强随机密钥。",
        { reason: jwtPlaceholder },
      );
      throw new Error("JWT_SECRET 使用了公开占位值，拒绝启动");
    }

    // TFA 加密密钥启动校验（fail-fast，评审 P2 修复）：
    // TFA_ENCRYPTION_KEY 用于 AES-256-GCM 加密 TOTP secret，缺失/过短时
    // 必须拒绝启动。否则 setup 请求会返回 500，或密钥丢失后已启用 TFA 的
    // 用户无法登录（secret 无法解密）。
    const tfaKey = Deno.env.get("TFA_ENCRYPTION_KEY");
    if (!tfaKey || tfaKey.length < MIN_TFA_ENCRYPTION_KEY_LENGTH) {
      const actualLength = tfaKey ? tfaKey.length : 0;
      logger.error(
        "TFA_ENCRYPTION_KEY 未设置或长度不足（当前 {actual} 字符，需要至少 {min} 字符）。\n" +
          "TFA_ENCRYPTION_KEY 是 TOTP secret 的 AES-256-GCM 加密密钥，必须独立于 JWT_SECRET 配置。\n" +
          "可通过 `openssl rand -base64 48` 生成强随机密钥。",
        { actual: actualLength, min: MIN_TFA_ENCRYPTION_KEY_LENGTH },
      );
      throw new Error("TFA_ENCRYPTION_KEY 未设置或长度不足，拒绝启动");
    }
    const tfaPlaceholder = describePlaceholderSecret(
      "TFA_ENCRYPTION_KEY",
      tfaKey,
    );
    if (tfaPlaceholder) {
      logger.error(
        "{reason}。\n" +
          "请不要直接使用示例/占位密钥；可通过 `openssl rand -base64 48` 生成强随机密钥。",
        { reason: tfaPlaceholder },
      );
      throw new Error("TFA_ENCRYPTION_KEY 使用了公开占位值，拒绝启动");
    }

    // HTTP 进程只读核对打包迁移资产与数据库 ledger；迁移必须由显式运维命令执行。
    await fatalStep("数据库 schema 兼容性检查", async () => {
      await assertSchemaCompatible();
    });

    // 校验系统设置注册表（issue #99）
    // 启动期检查：key 唯一、type 合法。开发期就发现问题。
    await fatalStep("系统设置注册表校验", () => validateRegistry());

    // 初始化系统设置缓存（issue #99）
    // 从 system_settings 全量加载到内存 Map，失败时终止启动。
    await fatalStep("系统设置缓存初始化", () => initSystemSettings());
    // 启动期 env 快照（issue #99）
    // 一次性读取 env-only 设置项到内存 Map，admin 面板只读展示。
    snapshotEnv();

    // issue #426：启动摘要中明确邮件服务就绪状态。
    // disabled 允许启动，但邮箱验证/密码找回不可用，公开注册会被禁止
    // （仅保留首个引导用户），必须在开放注册前完成邮件配置。
    const emailStatus = getEmailConfigStatus();
    if (emailStatus.configured) {
      logger.info("邮件服务已就绪", { provider: emailStatus.provider });
    } else {
      logger.warn(
        "邮件服务未就绪：邮箱验证与密码找回不可用，公开注册已被禁止" +
          "（仅允许站点引导阶段的首次注册）。开放公开注册前请在管理后台完成邮件配置并发送测试邮件。",
        {
          provider: emailStatus.provider,
          missing: emailStatus.missing,
        },
      );
    }

    // 提示 runtime（DB-owned）项同时存在 DB 值与 env 兜底：
    // 当前 DB 值优先，env 被遮蔽；建议移除 .env 对应变量以避免歧义。
    try {
      const conflicts = listRuntimeEnvConflicts();
      if (conflicts.length > 0) {
        logger.warn(
          "以下 {count} 项 runtime 配置同时存在 DB 值与 env 兜底，" +
            "当前 DB 值优先；建议移除 .env 中对应变量以避免歧义：",
          {
            count: conflicts.length,
            keys: conflicts.map((c) => `${c.key} (${c.envKey})`),
          },
        );
      }
    } catch (err) {
      // 检测失败不阻断启动（仅提示）
      logger.warn("runtime env/DB 共存冲突检测失败", { err });
    }

    // 提示平台默认 LLM 配置**只配了一半**（2026-09-22 评审）：
    // `llm_default_provider_id` / `llm_default_model` 必须同时配置，否则 LLM 题
    // 提交会以 400 失败。部署者常只取消注释其中一项（模板里两项都是注释示例），
    // 因此在启动时给出可操作告警，而不是等用户提交才暴露。
    try {
      const gap = describeLlmPlatformDefaultGap();
      if (gap.length > 0) {
        logger.warn(
          "平台默认 LLM 配置不完整：{missing} 未设置，LLM 题提交会返回 400。" +
            "请把 llm_default_provider_id 与 llm_default_model 配成一对" +
            "（管理后台「系统设置」或 .env.prod）。",
          { missing: gap.join(", ") },
        );
      }
    } catch (err) {
      // 检测失败不阻断启动（仅提示）
      logger.warn("平台默认 LLM 配置完整性检测失败", { err });
    }

    // 提示 bootstrap（env-owned）项在 DB 中的残留旧值：
    // 这些行已不参与取值（读取走 env），仅在管理后台可一键清理。
    try {
      const orphans = await listOrphanedBootstrapRows();
      if (orphans.length > 0) {
        logger.warn(
          "以下 {count} 项已由环境变量接管，DB 旧值不再生效，" +
            "可到管理后台「环境配置」一键清理：",
          {
            count: orphans.length,
            keys: orphans.map((r) =>
              `${r.key}（更新于 ${r.updated_at ?? "?"}，更新人 ${
                r.updated_by ?? "?"
              }）`
            ),
          },
        );
      }
    } catch (err) {
      // 残留检测失败不阻断启动（仅提示）
      logger.warn("bootstrap 残留 DB 行检测失败", { err });
    }

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
      // 三级优先级队列升级：把旧单队列残留任务迁入 medium，避免升级瞬间
      // 在途任务永久卡在 pending/judging（幂等、失败不阻断启动）。
      await migratePoolJudgeQueues();
      await migrateLegacyJudgeQueue();
    } catch (err) {
      if (err instanceof Error && /迁移|processing/.test(err.message)) {
        throw err;
      }
      logger.error("Redis 连接失败，评测分发功能不可用", { err });
    }

    await fatalStep("教学 outbox 迁移", migrateEducationOutboxAtStartup);

    // 后台任务统一登记（P2a）：所有组件都提供 stop()/done，关闭时按逆序停止、
    // 等待在途工作结束，再关闭 Redis 与数据库连接。登记顺序即启动顺序。
    // 启动评测结果消费者池（后台运行，带自动重连，不阻塞 HTTP）
    backgroundTasks.add(startResultConsumerPool());

    // 启动私信异步内容审核消费者（issue #413；Redis 不可用时自动重试，不阻断启动）
    backgroundTasks.add(startReviewConsumer());

    // 启动搜索索引事件消费者（后台运行，带自动重连，不阻塞 HTTP）
    backgroundTasks.add(startSearchIndexConsumer());

    // 启动 processing 超时重投 + pending 提交恢复 sweeper
    backgroundTasks.add(startQueueSweeper());

    // 启动批量任务 worker（管理员重测 / 用户升级条目派发；Handbook §5.7）
    backgroundTasks.add(startSubmissionJobWorker());
    backgroundTasks.add(startTaskWorker({
      workerId: `core-${crypto.randomUUID()}`,
      handlers: createBackgroundHandlers(),
    }));
    backgroundTasks.add(startEducationEmailWorker());
    backgroundTasks.add(startEducationPublishingWorker());
    backgroundTasks.add(startDomainStorageReconciliation());

    // 初始化 Redis Pub/Sub 事件订阅者（后台运行，用于 SSE 推送）
    backgroundTasks.add(initEventSubscriber());
    // 系统设置跨副本失效监听必须归入同一任务组：停止时退订并等待在途 reload。
    backgroundTasks.add(registerSettingsInvalidationListener());

    // 启动 HTTP 服务（保留 server 句柄用于优雅关闭）
    server = Deno.serve({ port }, app.fetch);

    // 启动后台审计日志保留任务
    backgroundTasks.add(startAuditLogRetentionTask());

    // 启动 SSE 事件保留任务（A4：事件表保留策略，默认 7 天）
    backgroundTasks.add(startSseEventRetentionTask());

    // NOJ-030：监听 SIGTERM/SIGINT，先停止接收新请求与任务领取，再等全部
    // 在途工作结束，最后关闭 Redis/DB；任一失败或超时都以非零码退出。
    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info("收到关闭信号，开始优雅关闭", { signal });

      const report = await performShutdown({
        http: {
          name: "http-server",
          shutdown: () => server!.shutdown(),
        },
        tasks: backgroundTasks,
        connections: {
          name: "sse-streams",
          closeAll: () => sseStreams.closeAll(),
          doneAll: () => sseStreams.doneAll(),
        },
        resources: shutdownResources,
        httpTimeoutMs: 10_000,
        tasksTimeoutMs: 20_000,
        connectionsTimeoutMs: 20_000,
        resourceTimeoutMs: 10_000,
      });

      if (report.httpDrained) {
        logger.info("HTTP 已完成排空");
      } else {
        logger.error("HTTP 未在时限内完成排空", { timeout_ms: 10_000 });
      }
      if (report.tasksSettled) {
        logger.info("后台任务已结束在途工作", {
          tasks: backgroundTasks.names(),
        });
      } else {
        logger.error("后台任务未在时限内结束", { timeout_ms: 20_000 });
      }
      if (report.connectionsSettled) {
        logger.info("SSE 长连接已完成收尾", {
          closed: report.connectionsClosed,
        });
      } else {
        logger.error("SSE 长连接未在时限内完成收尾", { timeout_ms: 20_000 });
      }
      for (const problem of report.problems) {
        logger.error("关闭阶段问题", {
          phase: problem.phase,
          subject: problem.subject,
          kind: problem.kind,
          message: problem.message,
        });
      }

      if (report.clean) {
        logger.info("资源已清理，进程退出", { summary: report.summary });
        Deno.exit(0);
      }
      if (report.forceExit) {
        logger.error(
          "非干净关闭：仍有在途工作，已跳过 Redis/数据库关闭并以非零码强制退出" +
            "（连接由进程退出回收）",
          { summary: report.summary },
        );
      } else {
        logger.error("关闭结束但存在错误，以非零码退出", {
          summary: report.summary,
        });
      }
      Deno.exit(report.exitCode);
    };

    Deno.addSignalListener("SIGTERM", () => {
      void gracefulShutdown("SIGTERM");
    });
    Deno.addSignalListener("SIGINT", () => {
      void gracefulShutdown("SIGINT");
    });

    logger.info("noj-core 已启动", { url: `http://localhost:${port}` });
  } catch (err) {
    logger.error("启动装配失败，回滚已启动的后台任务与连接", { err });
    const report = await performShutdown({
      http: server
        ? { name: "http-server", shutdown: () => server!.shutdown() }
        : noHttp,
      tasks: backgroundTasks,
      connections: {
        name: "sse-streams",
        closeAll: () => sseStreams.closeAll(),
        doneAll: () => sseStreams.doneAll(),
      },
      resources: shutdownResources,
      httpTimeoutMs: server ? 10_000 : 0,
      tasksTimeoutMs: 20_000,
      connectionsTimeoutMs: 20_000,
      resourceTimeoutMs: 10_000,
    });
    for (const problem of report.problems) {
      logger.error("启动回滚关闭问题", {
        phase: problem.phase,
        subject: problem.subject,
        kind: problem.kind,
        message: problem.message,
      });
    }
    if (report.forceExit) {
      logger.error("启动回滚未能干净结束，强制退出（连接由进程退出回收）", {
        summary: report.summary,
      });
    } else {
      logger.error("启动失败，回滚完成，以非零码退出", {
        summary: report.summary,
      });
    }
    Deno.exit(1);
  }
}
