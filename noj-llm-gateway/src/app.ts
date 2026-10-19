/**
 * noj-llm-gateway Hono 应用工厂。
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { GatewayConfig } from "./config.ts";
import { requestIdMiddleware } from "./context.ts";
import { createDb, type Db } from "./db.ts";
import { createRedis, type RedisClient } from "./redis.ts";
import { createLlmRouter } from "./routes/llm.ts";
import { createInternalRouter } from "./routes/internal.ts";
import { renderMetrics } from "./metrics.ts";
import { startUsageRetention } from "./usage.ts";
import {
  type AccountingWorkerHandle,
  type AccountingWorkerStatus,
  evaluateAccountingWorkerHealth,
  startAccountingWorker,
} from "./accounting.ts";

/** /health/ready 单类依赖的检查结果。 */
export type ReadyCheckStatus = "ok" | "error";

/** /health/ready 三类依赖的检查结果。 */
export interface ReadyChecks {
  /** 数据库是否可执行真实查询（SELECT 1）。 */
  database: ReadyCheckStatus;
  /** Redis ping 是否成功。 */
  redis: ReadyCheckStatus;
  /** 记账 worker 是否运行且最近没有持续失败。 */
  accounting: ReadyCheckStatus;
}

/** /health/ready 探测结果：只含非敏感类别，不携带底层错误详情。 */
export interface ReadyReport {
  /** 三类依赖全部 ok 时为 true。 */
  ready: boolean;
  /** 逐类依赖状态（供结构化消费方区分失败类别）。 */
  checks: ReadyChecks;
  /** 失败类别代码（如 database_unavailable）；ready 时为空数组。 */
  failures: string[];
}

/** 就绪探测所需的依赖；null 表示该依赖未配置或不可查询。 */
export interface ReadyProbeDeps {
  /** 数据库连接；null 表示未配置。 */
  db: Db | null;
  /** Redis 连接；null 表示未配置。 */
  redis: RedisClient | null;
  /** 记账 worker 状态读取函数；null 表示没有可查询的 worker。 */
  accounting: (() => AccountingWorkerStatus | null) | null;
}

/** createApp 的可选依赖注入点（测试与外部生命周期管理使用）。 */
export interface CreateAppDeps {
  /** 覆盖数据库连接；显式传 null 表示无数据库。缺省按 config.databaseUrl 创建。 */
  db?: Db | null;
  /** 覆盖 Redis 连接；显式传 null 表示无 Redis。缺省按 config.redisUrl 创建。 */
  redis?: RedisClient | null;
  /** 覆盖记账 worker 句柄；显式传 null 表示无 worker。缺省由 createApp 启动。 */
  accountingWorker?: AccountingWorkerHandle | null;
  /** 是否启动后台任务（usage retention 与默认记账 worker），缺省 true；单测必须置 false。 */
  startBackgroundWorkers?: boolean;
}

/** 数据库探针：真实执行 SELECT 1，失败只返回非敏感类别代码。 */
async function checkDatabase(db: Db | null): Promise<string | null> {
  if (!db) return "database_not_configured";
  try {
    const rows = (await db`SELECT 1 AS ok`) as unknown as Array<
      { ok?: unknown }
    >;
    // SELECT 1 必须且只能返回一行 ok=1；空结果/异常值说明连接或协议异常。
    if (
      !Array.isArray(rows) || rows.length !== 1 || Number(rows[0]?.ok) !== 1
    ) {
      return "database_unexpected_result";
    }
    return null;
  } catch {
    return "database_unavailable";
  }
}

/** Redis 探针：ping 成功即视为可写（失败只返回非敏感类别代码）。 */
async function checkRedis(redis: RedisClient | null): Promise<string | null> {
  if (!redis) return "redis_not_configured";
  try {
    await redis.ping();
    return null;
  } catch {
    return "redis_unavailable";
  }
}

/** 记账 worker 探针：读取状态并判定运行/持续失败，失败返回非敏感类别代码。 */
function checkAccounting(
  readStatus: (() => AccountingWorkerStatus | null) | null,
): string | null {
  if (!readStatus) return "accounting_worker_missing";
  const status = readStatus();
  if (!status) return "accounting_worker_missing";
  const health = evaluateAccountingWorkerHealth(status);
  return health.healthy ? null : `accounting_${health.reason ?? "unhealthy"}`;
}

/**
 * 创建 /health/ready 探针：真实执行数据库查询与 Redis ping，并读取记账 worker 状态。
 *
 * 三类检查并行执行；任一失败即整体不 ready。返回值只含固定的非敏感类别代码，
 * 不回显底层错误信息（连接串/主机等）。
 *
 * @param deps 探测依赖（可为 null 表示未配置）
 * @returns 执行一次探测的异步函数
 */
export function createReadyProbe(
  deps: ReadyProbeDeps,
): () => Promise<ReadyReport> {
  return async () => {
    const [database, redis, accounting] = await Promise.all([
      checkDatabase(deps.db),
      checkRedis(deps.redis),
      checkAccounting(deps.accounting),
    ]);
    const checks: ReadyChecks = {
      database: database === null ? "ok" : "error",
      redis: redis === null ? "ok" : "error",
      accounting: accounting === null ? "ok" : "error",
    };
    const failures = [database, redis, accounting].filter(
      (failure): failure is string => failure !== null,
    );
    return { ready: failures.length === 0, checks, failures };
  };
}

/**
 * 创建 Hono 应用；DB/Redis 可用时挂载代理与内部管理路由。
 *
 * 生产入口只传 config；测试可经 deps 注入假 db/redis/worker 并置
 * startBackgroundWorkers=false，从而不建立真实连接、不启动真实定时器。
 *
 * @param config 网关配置
 * @param deps 可选依赖注入（测试/外部生命周期管理用）
 * @returns Hono 应用实例
 */
export function createApp(config: GatewayConfig, deps: CreateAppDeps = {}) {
  const app = new Hono();

  // 请求上下文最先挂载：使后续所有路由/服务的日志自动带上同一 request_id。
  app.use("*", requestIdMiddleware());

  // 入站请求体限制在 10MB 以内，超出直接 413，防止超大包 DoS（GW-01 / GW-03）。
  app.use(
    "*",
    bodyLimit({
      maxSize: 10 * 1024 * 1024,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
  );

  const db = deps.db !== undefined
    ? deps.db
    : config.databaseUrl
    ? createDb(config.databaseUrl)
    : null;
  const redis = deps.redis !== undefined
    ? deps.redis
    : config.redisUrl
    ? createRedis(config.redisUrl)
    : null;

  const startBackgroundWorkers = deps.startBackgroundWorkers ?? true;
  let accountingWorker: AccountingWorkerHandle | null = deps.accountingWorker ??
    null;
  if (startBackgroundWorkers && db && redis) {
    // llm_usage 保留期清理（G-04）：多副本经 Redis 锁互斥，仅一个副本执行
    startUsageRetention(db, redis, config.usageRetentionDays);
    // 未显式注入（undefined）时启动默认记账 worker；显式 null 表示调用方声明无 worker，
    // 不得回退启动（否则就绪探针会掩盖调用方禁用记账的意图）。P5 接入优雅关闭。
    if (deps.accountingWorker === undefined) {
      accountingWorker = startAccountingWorker(db, redis);
    }
  }
  const worker = accountingWorker;
  const readyProbe = createReadyProbe({
    db,
    redis,
    accounting: worker ? () => worker.getStatus() : null,
  });

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      service: "noj-llm-gateway",
      time: new Date().toISOString(),
    });
  });

  app.get("/health/live", (c) => {
    return c.json({
      status: "alive",
      service: "noj-llm-gateway",
      contract_version: 1,
      time: new Date().toISOString(),
    });
  });

  app.get("/health/ready", async (c) => {
    const report = await readyProbe();
    const service = "noj-llm-gateway";
    if (!report.ready) {
      // detail 只含 db/redis/accounting 三类非敏感失败代码，便于区分故障来源。
      return c.json({
        status: "not_ready",
        service,
        detail: report.failures,
        checks: report.checks,
      }, 503);
    }
    return c.json({ status: "ready", service, checks: report.checks });
  });

  app.get("/metrics", (c) => {
    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.body(renderMetrics());
  });

  if (db && redis) {
    app.route("/", createLlmRouter({ config, db, redis }));
    app.route("/", createInternalRouter({ config, db, redis }));
  }

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  return app;
}
