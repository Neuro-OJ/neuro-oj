/**
 * 平台审计合同。
 *
 * 审计是平台事实写入，不再从 Hono Context/AsyncLocalStorage 猜操作者。HTTP
 * 适配层必须把已经认证的 UserActor 和不可变请求元数据显式传入；bootstrap 或
 * 后台任务则传入受控 SystemActor。
 */
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Actor, UserActor } from "../../access/contracts/actor.ts";
import { getDb } from "../../../shared/db/connection.ts";
import { auditLogs } from "../../../shared/db/schema.ts";
import { getLogger } from "@logtape/logtape";
import {
  type ManagedTask,
  startPeriodicTask,
} from "../../../shared/runtime/managed-task.ts";
import type {
  AuditAction,
  AuditDetail,
  AuditLogEntry,
  AuditLogListFilter,
} from "../types/audit-log.ts";

const logger = getLogger(["noj", "platform"]);

export interface AuditMeta {
  readonly ipAddress: string;
  readonly requestId?: string;
}

function actorId(actor: Actor | null): string | null {
  return actor?.kind === "user" ? actor.userId : null;
}

/** 显式记录平台审计；数据库失败只记录脱敏错误，业务调用方保留既有语义。 */
export async function recordAudit(
  actor: Actor | null,
  meta: AuditMeta,
  action: AuditAction,
  detail: AuditDetail,
  target?: { type: string; id: string },
): Promise<void> {
  try {
    await getDb().insert(auditLogs).values({
      id: crypto.randomUUID(),
      admin_id: actorId(actor),
      action,
      target_type: target?.type ?? null,
      target_id: target?.id ?? null,
      detail: detail as unknown as Record<string, unknown>,
      ip_address: meta.ipAddress || "unknown",
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    const pgError = error as Record<string, unknown>;
    logger.error("平台审计日志写入失败", {
      action,
      error_type: error instanceof Error ? error.name : typeof error,
      pg_code: typeof pgError.code === "string" ? pgError.code : undefined,
      constraint: typeof pgError.constraint === "string"
        ? pgError.constraint
        : undefined,
    });
  }
}

/** 认证事件不要求已有登录 actor；主体为空时保留 null。 */
export async function recordAuthAudit(
  actor: UserActor | null,
  clientIp: string,
  action: AuditAction,
  detail: Omit<AuditDetail, "action">,
): Promise<void> {
  await recordAudit(
    actor,
    { ipAddress: clientIp },
    action,
    { ...detail, action } as AuditDetail,
    actor ? { type: "user", id: actor.userId } : undefined,
  );
}

/** 认证路径审计适配：主体可为空，且不依赖 HTTP RequestContext。 */
export async function logAuthEvent(
  actorUserId: string | null,
  clientIp: string,
  action: AuditAction,
  detail: Omit<AuditDetail, "action">,
): Promise<void> {
  const actor = actorUserId
    ? {
      kind: "user" as const,
      userId: actorUserId as UserActor["userId"],
    }
    : null;
  await recordAuthAudit(actor, clientIp, action, detail);
}

/** 仅供尚未切换 HTTP adapter 的平台子服务过渡；新调用必须使用 recordAudit。 */
export async function logAudit(
  action: AuditAction,
  detail: AuditDetail,
  target?: { type: string; id: string },
): Promise<void> {
  await recordAudit(null, { ipAddress: "system" }, action, detail, target);
}

export async function listAuditLogs(
  filter: AuditLogListFilter,
): Promise<{
  data: AuditLogEntry[];
  pagination: { page: number; per_page: number; total: number };
}> {
  const { page, perPage, admin_id, action, from, to } = filter;
  const db = getDb();
  const conditions: ReturnType<typeof sql>[] = [];
  if (admin_id) conditions.push(eq(auditLogs.admin_id, admin_id));
  else conditions.push(sql`${auditLogs.admin_id} IS DISTINCT FROM '0'`);
  if (action) conditions.push(eq(auditLogs.action, action));
  if (from) conditions.push(gte(auditLogs.created_at, from));
  if (to) conditions.push(lte(auditLogs.created_at, to));
  const whereClause = and(...conditions);
  const [rows, totalResult] = await Promise.all([
    db.select().from(auditLogs).where(whereClause)
      .orderBy(desc(auditLogs.created_at)).limit(perPage)
      .offset((page - 1) * perPage),
    db.select({ count: sql<number>`count(*)::int` }).from(auditLogs)
      .where(whereClause),
  ]);
  return {
    data: rows.map((row) => ({
      id: row.id,
      admin_id: row.admin_id,
      action: row.action as AuditAction,
      target_type: row.target_type,
      target_id: row.target_id,
      detail: row.detail as unknown as AuditDetail,
      ip_address: row.ip_address,
      created_at: row.created_at,
    })),
    pagination: {
      page,
      per_page: perPage,
      total: totalResult[0]?.count ?? 0,
    },
  };
}

export async function cleanupOldAuditLogs(
  retentionDays: number,
): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(
    Date.now() - retentionDays * 86400 * 1000,
  ).toISOString();
  const result = await getDb().delete(auditLogs).where(
    lte(auditLogs.created_at, cutoff),
  );
  const row = result as unknown as {
    affectedRows?: number;
    rowCount?: number;
    count?: number;
  };
  return row.affectedRows ?? row.rowCount ?? row.count ?? 0;
}

const AUDIT_RETENTION_INTERVAL_MS = 86_400_000;
let retentionTask: ManagedTask | null = null;

/**
 * 审计保留天数属于 bootstrap 配置：它由环境变量在启动期定型，DB 中的残留行
 * 不参与取值。这里直接读取环境变量，避免审计 writer 与 platform settings
 * 形成运行时环；旧 settings service 仍负责注册表校验与管理端展示。
 */
function auditRetentionDays(): number {
  const raw = Deno.env.get("AUDIT_LOG_RETENTION_DAYS");
  if (!raw) return 90;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : 90;
}

/** runtime 只需持有此 descriptor；任务本身不泄漏到 platform 公共门面。 */
export function startAuditLogRetentionTask(): ManagedTask {
  if (retentionTask) return retentionTask;
  const retentionDays = auditRetentionDays();
  if (retentionDays <= 0) {
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
      const removed = await cleanupOldAuditLogs(retentionDays);
      if (removed > 0) logger.info("平台审计日志清理完成", { removed });
    },
    onError: (error) =>
      logger.error("平台审计日志清理失败", {
        error_type: error instanceof Error ? error.name : typeof error,
      }),
  });
  retentionTask = task;
  void task.done.then(() => {
    if (retentionTask === task) retentionTask = null;
  }).catch(() => {});
  return task;
}

/** 测试/受管关闭适配器：停止当前任务，等待由调用方统一收尾。 */
export function _resetAuditLogRetentionForTest(): void {
  retentionTask?.stop();
}
