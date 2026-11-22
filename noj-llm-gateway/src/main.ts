/**
 * noj-llm-gateway 入口。
 */
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { assertMigrationsCompatible } from "./db/migrate.ts";
import { createDb, type Db } from "./db.ts";
import { createRedis, type RedisClient } from "./redis.ts";
import {
  type AccountingWorkerHandle,
  startAccountingWorker,
} from "./accounting.ts";
import { startUsageRetention } from "./usage.ts";
import {
  assertGatewayDependencies,
  createManagedTaskGroup,
} from "./runtime.ts";
import { logger, setupGatewayLogging } from "./logger.ts";

// 尽早装配日志：先于任何可能失败的启动步骤（迁移/种子），
// 否则这些步骤失败时没有任何结构化输出可供排查。
setupGatewayLogging();

const config = loadConfig();

/** HTTP/后台任务排空的统一硬上限；超时必须非零退出，避免半关闭继续接流量。 */
export const GATEWAY_SHUTDOWN_TIMEOUT_MS = 20_000;

class GatewayShutdownTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`${name} 在 ${timeoutMs}ms 内未完成排空`);
    this.name = "GatewayShutdownTimeoutError";
  }
}

async function waitWithTimeout<T>(
  operation: Promise<T>,
  name: string,
  timeoutMs = GATEWAY_SHUTDOWN_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new GatewayShutdownTimeoutError(name, timeoutMs));
    }, timeoutMs);
    timer = timeoutId;
    Deno.unrefTimer(timeoutId);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// HTTP 启动只做只读 schema 检查；迁移和默认配额种子由独立 db:migrate 一次性命令执行。
await assertMigrationsCompatible(config.databaseUrl);

let db: Db | null = null;
let redis: RedisClient | null = null;
let accounting: AccountingWorkerHandle | null = null;
let server: ReturnType<typeof Deno.serve> | null = null;
const tasks = createManagedTaskGroup();

async function closeResources(): Promise<void> {
  // 后台任务仍在途时禁止先关 Redis/DB：请求或结算可能还持有连接并需要完成。
  tasks.stopAll();
  const failures: unknown[] = [];
  try {
    await waitWithTimeout(tasks.doneAll(), "Gateway 后台任务");
  } catch (error) {
    // done 已 settle 但报告失败时仍可安全释放连接；超时则可能仍有在途工作，
    // 必须立刻以非零码退出并跳过 Redis/DB 关闭，避免截断这些操作。
    if (error instanceof GatewayShutdownTimeoutError) throw error;
    failures.push(error);
  }
  try {
    await waitWithTimeout(
      redis?.quit?.() ?? Promise.resolve(),
      "Gateway Redis 关闭",
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    await waitWithTimeout(db?.end() ?? Promise.resolve(), "Gateway 数据库关闭");
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Gateway 资源关闭失败");
  }
}

try {
  db = createDb(config.databaseUrl);
  redis = createRedis(config.redisUrl);
  // 客户端构造本身可能是惰性的；在监听前显式探测两项必需依赖，
  // 避免 Redis/数据库缺失时仍启动一个只有 /health 的半成品进程。
  await assertGatewayDependencies(db, redis);
  accounting = startAccountingWorker(db, redis);
  tasks.add({
    name: "gateway-accounting",
    stop: () => accounting!.stop(),
    done: accounting.done,
  });
  tasks.add(startUsageRetention(db, redis, config.usageRetentionDays));

  const app = createApp(config, { db, redis, accountingWorker: accounting });
  server = Deno.serve({ port: config.port }, app.fetch);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("收到关闭信号，开始 Gateway 优雅关闭", { signal });
    try {
      // 先停止接收并排空 HTTP（含流式请求），再停止后台任务并关闭依赖。
      await waitWithTimeout(
        server?.shutdown() ?? Promise.resolve(),
        "Gateway HTTP",
      );
      await closeResources();
      logger.info("Gateway 已完成优雅关闭");
      Deno.exit(0);
    } catch (error) {
      logger.error("Gateway 关闭失败，非零退出", {
        error: error instanceof Error ? error.message : String(error),
      });
      Deno.exit(1);
    }
  };
  Deno.addSignalListener("SIGTERM", () => void shutdown("SIGTERM"));
  Deno.addSignalListener("SIGINT", () => void shutdown("SIGINT"));
  logger.info("noj-llm-gateway 已启动", { port: config.port });
} catch (error) {
  logger.error("Gateway 启动装配失败，开始清理", {
    error: error instanceof Error ? error.message : String(error),
  });
  // HTTP 排空和依赖释放必须分别尝试：shutdown() 失败时也不能跳过
  // 已创建任务/连接的回收，否则部分初始化会把资源留到进程退出。
  const cleanupErrors: unknown[] = [];
  let httpDrained = true;
  try {
    await waitWithTimeout(
      server?.shutdown() ?? Promise.resolve(),
      "Gateway HTTP 启动回滚",
    );
  } catch (cleanupError) {
    httpDrained = false;
    cleanupErrors.push(cleanupError);
  }
  if (httpDrained) {
    try {
      await closeResources();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  } else {
    // 与正常关闭的 force-exit 语义一致：HTTP 未排空时不能先关依赖，
    // 否则仍在途请求可能继续访问已关闭的 DB/Redis。进程随后以非零码退出，
    // 由进程退出回收残余连接。
    tasks.stopAll();
    cleanupErrors.push(
      new Error("Gateway HTTP 启动回滚未完成，跳过 Redis/数据库关闭"),
    );
  }
  if (cleanupErrors.length > 0) {
    logger.error("Gateway 启动回滚失败", {
      error: cleanupErrors.map((cleanupError) =>
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError)
      ).join("; "),
    });
  }
  Deno.exit(1);
}
