/**
 * 审计日志 service（issue #101）。
 *
 * 提供：
 * - logAudit() —— service 层同步写入，失败仅 console.error
 * - listAuditLogs() —— 分页 + 多维度筛选，默认排除 root
 * - cleanupOldAuditLogs() —— 按 created_at 阈值删除
 * - startAuditLogRetentionTask() —— 可停止、可等待的周期保留任务
 */

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { auditLogs } from "./../../../shared/db/schema.ts";
import { getRequestContext } from "./request-context.ts";
import { getSetting } from "./system-settings.ts";
import { getLogger } from "@logtape/logtape";
import {
  type ManagedTask,
  startPeriodicTask,
} from "../../../shared/runtime/managed-task.ts";

const logger = getLogger(["noj", "system"]);
import type {
  AuditAction,
  AuditDetail,
  AuditLogEntry,
  AuditLogListFilter,
} from "./../types/audit-log.ts";

/**
 * 记录一条审计日志。必须在 admin 路由内调用（依赖 RequestContext）。
 * CLI/脚本场景（无 RequestContext）静默跳过——非 HTTP 上下文不产生审计事件；
 * 其他失败仅 logger.error，业务操作继续。
 */
export async function logAudit(
  action: AuditAction,
  detail: AuditDetail,
  target?: { type: string; id: string },
): Promise<void> {
  try {
    const ctx = getRequestContext();
    const db = getDb();
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      admin_id: ctx.actorId,
      action,
      target_type: target?.type ?? null,
      target_id: target?.id ?? null,
      detail: detail as unknown as Record<string, unknown>,
      ip_address: ctx.actorIp,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    // CLI/脚本场景无 RequestContext 属预期行为，静默跳过
    if (
      e instanceof Error &&
      e.message.includes("RequestContext 未注入")
    ) {
      return;
    }
    const pgErr = e as Record<string, unknown>;
    logger.error("审计日志写入失败 (logAudit)", {
      action,
      err: e,
      pg_code: typeof pgErr.code === "string" ? pgErr.code : undefined,
      constraint: typeof pgErr.constraint === "string"
        ? pgErr.constraint
        : undefined,
      detail: typeof pgErr.detail === "string" ? pgErr.detail : undefined,
    });
  }
}

/**
 * 记录认证相关审计事件（PR-2）。
 *
 * 与 `logAudit` 的区别：
 * - **不依赖 RequestContext**：可在登录/注册/忘记密码等"无 admin 上下文"的路径调用
 * - **actor 可为 null**：登录失败、未注册邮箱的密码重置请求等场景下没有 actor
 * - **目标用户是 actor 本人**（不是 admin 操作用户）：admin_id 字段语义变为
 *   "事件主体用户 ID"（失败时为 null）
 *
 * 失败行为同 logAudit：仅 console.error，业务继续。
 *
 * @param actorUserId - 触发事件的用户 ID（登录失败/未注册邮箱时为 null）
 * @param clientIp - 客户端 IP（用于追溯攻击源）
 * @param action - 审计动作（必须是 auth.* 子集）
 * @param detail - 强类型 detail
 */
export async function logAuthEvent(
  actorUserId: string | null,
  clientIp: string,
  action: AuditAction,
  // action 由本函数自动填充，调用方无需（也不应）重复传入
  detail: Omit<AuditDetail, "action">,
): Promise<void> {
  try {
    const db = getDb();
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      admin_id: actorUserId, // 语义：事件主体用户 ID
      action,
      target_type: actorUserId ? "user" : null,
      target_id: actorUserId,
      // action 以函数参数为准，detail 中的同名键被覆盖
      detail: { ...detail, action } as unknown as Record<string, unknown>,
      ip_address: clientIp || "unknown",
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    const pgErr = e as Record<string, unknown>;
    logger.error("审计日志写入失败 (logAuthEvent)", {
      action,
      err: e,
      pg_code: typeof pgErr.code === "string" ? pgErr.code : undefined,
      constraint: typeof pgErr.constraint === "string"
        ? pgErr.constraint
        : undefined,
      detail: typeof pgErr.detail === "string" ? pgErr.detail : undefined,
    });
  }
}

/** 审计日志分页列表 + 多维度筛选。默认排除 root (admin_id='0')。 */
export async function listAuditLogs(
  filter: AuditLogListFilter,
): Promise<
  {
    data: AuditLogEntry[];
    pagination: { page: number; per_page: number; total: number };
  }
> {
  const { page, perPage, admin_id, action, from, to } = filter;
  const db = getDb();

  const conditions: ReturnType<typeof sql>[] = [];
  if (admin_id) {
    conditions.push(eq(auditLogs.admin_id, admin_id));
  } else {
    // 默认排除 root (admin_id='0')；PR-2 auth.* 事件 admin_id 可为 null
    // 也保留（登录失败等需要追溯），显式传 admin_id 仍可查询。
    // 用 IS DISTINCT FROM 而非 !=：NULL 与 '0' 比较结果为 NULL（不成立），
    // 会导致 admin_id=NULL 的 auth.* 行被误过滤。
    conditions.push(sql`${auditLogs.admin_id} IS DISTINCT FROM '0'`);
  }
  if (action) conditions.push(eq(auditLogs.action, action));
  if (from) conditions.push(gte(auditLogs.created_at, from));
  if (to) conditions.push(lte(auditLogs.created_at, to));

  const whereClause = and(...conditions);

  const [rows, totalResult] = await Promise.all([
    db.select()
      .from(auditLogs)
      .where(whereClause)
      .orderBy(desc(auditLogs.created_at))
      .limit(perPage)
      .offset((page - 1) * perPage),
    db.select({ count: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(whereClause),
  ]);

  return {
    data: rows.map((r) => ({
      id: r.id,
      admin_id: r.admin_id,
      action: r.action as AuditAction,
      target_type: r.target_type,
      target_id: r.target_id,
      detail: r.detail as unknown as AuditDetail,
      ip_address: r.ip_address,
      created_at: r.created_at,
    })),
    pagination: {
      page,
      per_page: perPage,
      total: totalResult[0]?.count ?? 0,
    },
  };
}

/** 按保留天数清理过期日志，返回删除行数 */
export async function cleanupOldAuditLogs(
  retentionDays: number,
): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(
    Date.now() - retentionDays * 86400 * 1000,
  ).toISOString();
  const db = getDb();
  const result = await db.delete(auditLogs).where(
    lte(auditLogs.created_at, cutoff),
  );
  // postgres.js RowList 暴露 count；Drizzle 类型未统一该字段，使用 unknown 强制访问。
  const r = result as unknown as {
    affectedRows?: number;
    rowCount?: number;
    count?: number;
  };
  return r.affectedRows ?? r.rowCount ?? r.count ?? 0;
}

/** 审计日志保留任务的轮询间隔：24 小时。 */
const AUDIT_RETENTION_INTERVAL_MS = 86_400_000;

/** 当前保留任务（单例；stop 后到 done 完成期间仍保留，防止重叠清理）。 */
let _auditRetentionTask: ManagedTask | null = null;

/**
 * 启动后台保留任务（HTTP 启动后由 main.ts 调用）。
 *
 * 返回统一后台任务句柄（P2a）：关闭时先 `stop()` 清定时器，再等待在途清理
 * 结束，避免数据库连接先关闭、清理任务继续写库。
 *
 * @returns 可停止、可等待的保留任务句柄
 */
export function startAuditLogRetentionTask(): ManagedTask {
  if (_auditRetentionTask !== null) return _auditRetentionTask;
  const setting = getSetting("audit_log_retention_days");
  const days = typeof setting?.value === "number"
    ? Math.floor(setting.value)
    : 90;
  if (days <= 0) {
    logger.info("审计日志清理任务已禁用", { retention_days: days });
    return {
      name: "audit-log-retention",
      stop: () => {},
      done: Promise.resolve(),
    };
  }
  const task = startPeriodicTask({
    name: "audit-log-retention",
    intervalMs: AUDIT_RETENTION_INTERVAL_MS,
    runImmediately: true,
    run: async () => {
      const removed = await cleanupOldAuditLogs(days);
      if (removed > 0) {
        logger.info("审计日志清理完成", { removed, retention_days: days });
      }
    },
    onError: (err) => logger.error("审计日志清理失败", { err }),
  });
  _auditRetentionTask = task;
  // done 完成后才释放单例；stop 后未完成期间重复启动返回同一句柄。
  void task.done.then(() => {
    if (_auditRetentionTask === task) _auditRetentionTask = null;
  });
  logger.info("审计日志保留任务已启动", { retention_days: days });
  return task;
}

/** 测试用：停止当前保留任务（不等待在途清理完成）。 */
export function _resetAuditLogRetentionForTest(): void {
  _auditRetentionTask?.stop();
}
