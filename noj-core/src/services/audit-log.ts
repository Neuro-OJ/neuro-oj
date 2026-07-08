/**
 * 审计日志 service（issue #101）。
 *
 * 提供：
 * - logAudit() —— service 层同步写入，失败仅 console.error
 * - listAuditLogs() —— 分页 + 多维度筛选，默认排除 root
 * - cleanupOldAuditLogs() —— 按 created_at 阈值删除
 * - startAuditLogRetentionTask() —— 后台 setInterval 任务
 */

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { auditLogs } from "../db/schema.ts";
import { getRequestContext } from "../lib/requestContext.ts";
import { getSetting } from "./system-settings.ts";
import type {
  AuditAction,
  AuditDetail,
  AuditLogEntry,
  AuditLogListFilter,
} from "../types/audit-log.ts";

/**
 * 记录一条审计日志。必须在 admin 路由内调用（依赖 RequestContext）。
 * 失败仅 console.error，业务操作继续。
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
    const msg = e instanceof Error ? e.message : String(e);
    const pgErr = e as Record<string, unknown>;
    const pgCode = typeof pgErr.code === "string" ? ` [${pgErr.code}]` : "";
    const pgConstraint = typeof pgErr.constraint === "string"
      ? ` (${pgErr.constraint})`
      : "";
    const pgDetail = typeof pgErr.detail === "string"
      ? `: ${pgErr.detail}`
      : "";
    console.error(
      `[audit] logAudit 失败 (action=${action}):${pgCode}${pgConstraint}${pgDetail}`,
      msg,
    );
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
    // 默认排除 root (admin_id='0')，显式传入 admin_id='0' 可覆盖
    conditions.push(sql`${auditLogs.admin_id} != '0'`);
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
  // 跨驱动兼容：PGlite 返回 { affectedRows }; postgres.js 返回 RowList 带 count
  // Drizzle 类型未统一这两个字段，使用 unknown 强制访问
  const r = result as unknown as {
    affectedRows?: number;
    rowCount?: number;
    count?: number;
  };
  return r.affectedRows ?? r.rowCount ?? r.count ?? 0;
}

/** 启动后台保留任务（HTTP 启动后由 main.ts 调用） */
export function startAuditLogRetentionTask(): void {
  const setting = getSetting("audit_log_retention_days");
  const days = typeof setting?.value === "number"
    ? Math.floor(setting.value)
    : 90;
  if (days <= 0) {
    console.info(
      `[audit] audit_log_retention_days=${days} 无效, 清理任务已禁用`,
    );
    return;
  }
  // 启动立即跑一次
  cleanupOldAuditLogs(days)
    .then((n) => console.info(`[audit] 启动清理: 移除 ${n} 条过期日志`))
    .catch((e) =>
      console.error(
        "[audit] 启动清理失败:",
        e instanceof Error ? e.message : String(e),
      )
    );
  // 每 24h 重复
  setInterval(() => {
    cleanupOldAuditLogs(days)
      .then((n) =>
        n > 0
          ? console.info(`[audit] 周期清理: 移除 ${n} 条过期日志`)
          : undefined
      )
      .catch((e) =>
        console.error(
          "[audit] 周期清理失败:",
          e instanceof Error ? e.message : String(e),
        )
      );
  }, 86400 * 1000);
  console.info(`[audit] 保留任务已启动: retention_days=${days}`);
}
