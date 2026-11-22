import { sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import * as schema from "./schema.ts";
import { getLogger } from "@logtape/logtape";
import { observability as metrics } from "../observability/registry.ts";
import type { ObservabilityRegistry } from "../observability/contracts.ts";
import { buildConnectionOptions } from "./options.ts";

const logger = getLogger(["noj", "db"]);

let _db: ReturnType<typeof drizzlePg> | null = null;
let _client: ReturnType<typeof postgres> | null = null;

/**
 * 获取 Drizzle ORM 数据库实例（进程级单例）。
 *
 * 生产与测试均只使用真实 PostgreSQL：缺少 `DATABASE_URL` 时明确失败，不再降级
 * 到 测试数据库 或任何内存数据库。测试数据库的创建、迁移与种子由测试启动器负责。
 *
 * @returns Drizzle postgres-js 数据库
 */
export function getDb() {
  if (_db) return _db;

  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL 未设置：数据库仅支持真实 PostgreSQL；测试请使用独立测试数据库启动器",
    );
  }

  try {
    const poolMax = parseInt(Deno.env.get("DATABASE_POOL_MAX") || "10", 10);
    const connectTimeout = parseInt(
      Deno.env.get("DATABASE_CONNECT_TIMEOUT") || "10",
      10,
    );
    const idleTimeout = parseInt(
      Deno.env.get("DATABASE_IDLE_TIMEOUT") || "300",
      10,
    );
    const maxLifetime = parseInt(
      Deno.env.get("DATABASE_MAX_LIFETIME") || "3600",
      10,
    );
    const jitDisabled = Deno.env.get("DATABASE_JIT")?.trim().toLowerCase() !==
      "on";
    _client = postgres(databaseUrl, {
      max: poolMax,
      connect_timeout: connectTimeout,
      idle_timeout: idleTimeout,
      max_lifetime: maxLifetime,
      connection: buildConnectionOptions(jitDisabled),
    });
    _db = drizzlePg(_client, { schema });
    return _db;
  } catch (err) {
    logger.error("数据库初始化失败", { err });
    throw err;
  }
}

/**
 * 检查数据库连接状态：执行 `SELECT 1` 验证连接可用。
 *
 * @returns 健康状态与可选错误文本
 */
export async function checkDbHealth(): Promise<
  { ok: boolean; error?: string }
> {
  const result = (ok: boolean, error?: string) => {
    metrics.inc("noj_database_health_checks_total");
    if (!ok) metrics.inc("noj_database_health_check_errors_total");
    return error ? { ok, error } : { ok };
  };
  if (!_client || !_db) return result(false, "未初始化");

  try {
    await _db.execute(sql`SELECT 1`);
    return result(true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return result(false, message);
  }
}

/**
 * 注册数据库健康探针。
 *
 * 由 application 组合根调用；shared/db 不依赖 modules/platform/observability。
 *
 * @param registry 可观测性注册表
 */
export function registerDbHealthProbe(registry: ObservabilityRegistry): void {
  registry.registerHealthProbe({
    name: "database",
    critical: true,
    timeoutMs: 1000,
    check: async () => {
      const started = performance.now();
      const health = await checkDbHealth();
      return {
        status: health.ok ? "up" : "down",
        latency_ms: Math.round(performance.now() - started),
        error: health.error,
      };
    },
  });
}

/** 数据库关闭阶段的最小可关闭句柄；null 表示连接未创建。 */
export interface DbShutdownHandles {
  /** 结束 postgres.js 连接池。 */
  endClient: (() => Promise<void> | void) | null;
}

/**
 * 关闭数据库资源：所有关闭步骤都独立 settle，最后以 `AggregateError` 汇总。
 *
 * 该函数不读取模块单例，便于用最小 fake 在无网络条件下验证异常传播。
 *
 * @param handles 待关闭资源
 */
export async function closeDbResources(
  handles: DbShutdownHandles,
): Promise<void> {
  const failures: Array<{ step: string; error: unknown }> = [];
  if (handles.endClient) {
    try {
      await handles.endClient();
    } catch (error) {
      failures.push({ step: "postgres-client", error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `数据库关闭失败：${
        failures
          .map((failure) =>
            `${failure.step}: ${
              failure.error instanceof Error
                ? failure.error.message
                : String(failure.error)
            }`
          )
          .join("；")
      }`,
    );
  }
}

/**
 * 优雅关闭：结束 postgres.js 连接池并释放单例引用。
 *
 * 关闭失败以 `AggregateError` 抛出，供 `performShutdown()` 记为资源关闭问题。
 */
export async function closeDbForShutdown(): Promise<void> {
  const client = _client;
  _client = null;
  _db = null;
  await closeDbResources({
    endClient: client ? () => client.end() : null,
  });
}
