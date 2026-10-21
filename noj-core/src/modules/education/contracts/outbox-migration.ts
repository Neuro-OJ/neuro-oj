/**
 * 教学 outbox → 通用后台任务的幂等迁移（P4）。
 *
 * 迁移期同时存在两套持久任务事实：
 * - 旧：`education_outbox`（教学专用，带 attempts/lease/cursor）；
 * - 新：`background_tasks`（通用，`education.recompute` 类型）。
 *
 * 切换顺序固定为：**先迁状态 → 再切生产者 → 最后停旧 worker**，不允许两套 worker
 * 同时执行同一任务。本文件只负责第一步，并且必须幂等：
 * - 每条 outbox 行映射到一条 `education.recompute` 任务，去重键使用 outbox id，
 *   重复执行命中唯一约束并返回既有任务；
 * - 保留任务身份（outbox id）、失败次数、可领取时刻与分页游标；
 * - 已处理（`processed_at` 非空）的行不迁移——它们已经完成，迁移只会制造重复工作；
 * - 迁移只读 outbox、只写 background_tasks，不修改旧表（回滚安全）。
 */
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { DbTx } from "../../../shared/db/executor.ts";
import { educationOutbox } from "../../../shared/db/schema.ts";
import { enqueueTaskTx } from "../../runtime/tasks/repository.ts";
import type { EnqueueTaskResult } from "../../runtime/tasks/contracts.ts";

/** 单次迁移的批量上限；调用方循环直到 `remaining === 0`。 */
export const EDUCATION_OUTBOX_MIGRATION_BATCH = 200;

/** 一条 outbox 行的迁移结果。 */
export interface EducationOutboxMigrationItem {
  readonly outboxId: string;
  readonly taskId: string;
  readonly created: boolean;
  /** 旧任务的连续失败次数，原样带入新任务（用于终态判定）。 */
  readonly failureCount: number;
  /** 旧任务的持久游标；存在时说明上一轮分页未完成。 */
  readonly hasCursor: boolean;
}

/** 一次批量迁移的结果。 */
export interface EducationOutboxMigrationResult {
  readonly items: readonly EducationOutboxMigrationItem[];
  /** 本批之后仍待迁移的行数（已处理行不计）。 */
  readonly remaining: number;
}

/** 旧 outbox 行的稳定任务去重键：保证重复迁移映射到同一条任务。 */
export function educationOutboxDedupeKey(outboxId: string): string {
  return `outbox:${outboxId}`;
}

/**
 * 幂等迁移一批待处理 outbox 行。
 *
 * @param tx 调用方事务；迁移与调用方其它状态变更一起提交或回滚
 * @param limit 本批上限（缺省 200）
 */
export async function migrateEducationOutboxTx(
  tx: DbTx,
  limit = EDUCATION_OUTBOX_MIGRATION_BATCH,
): Promise<EducationOutboxMigrationResult> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("迁移批量必须是正整数");
  }
  // 只迁移"尚未处理"的行；顺序按创建时间稳定推进，避免饿死旧任务。
  const rows = await tx.select().from(educationOutbox).where(
    and(
      isNull(educationOutbox.processed_at),
      or(
        isNull(educationOutbox.leased_until),
        lte(educationOutbox.leased_until, new Date().toISOString()),
      ),
    ),
  ).orderBy(asc(educationOutbox.created_at), asc(educationOutbox.id)).limit(
    limit,
  );

  const items: EducationOutboxMigrationItem[] = [];
  for (const row of rows) {
    const payload = row.payload ?? {};
    const hasCursor = typeof payload._education_cursor === "object" &&
      payload._education_cursor !== null;
    // payload 只带可恢复依据：定位字段 + 游标 + 原事件类型，不带成绩。
    const result: EnqueueTaskResult = await enqueueTaskTx(tx, {
      taskType: "education.recompute",
      targetKind: row.assignment_id ? "assignment" : "domain",
      targetId: row.assignment_id ?? row.domain_id,
      dedupeKey: educationOutboxDedupeKey(row.id),
      payloadVersion: 1,
      payload: {
        outbox_id: row.id,
        domain_id: row.domain_id,
        event_type: row.event_type,
        user_id: row.user_id,
        problem_id: row.problem_id,
        classroom_id: row.classroom_id,
        assignment_id: row.assignment_id,
        education_cursor: hasCursor ? payload._education_cursor : null,
      },
      availableAt: row.available_at,
    });
    items.push({
      outboxId: row.id,
      taskId: result.taskId,
      created: result.created,
      failureCount: row.attempts,
      hasCursor,
    });
  }

  const [remaining] = await tx.select({
    count: sql<number>`count(*)::int`,
  }).from(educationOutbox).where(
    and(
      isNull(educationOutbox.processed_at),
      or(
        isNull(educationOutbox.leased_until),
        lte(educationOutbox.leased_until, new Date().toISOString()),
      ),
      rows.length
        ? gt(educationOutbox.id, rows[rows.length - 1].id)
        : undefined,
    ),
  );
  return { items, remaining: remaining?.count ?? 0 };
}

/**
 * 迁移后标记旧行已处理（只用于确认迁移完成的清理步骤）。
 *
 * 必须在**所有**任务都成功迁移之后调用；否则会让未迁移的旧行被误判为完成。
 */
export async function markEducationOutboxMigratedTx(
  tx: DbTx,
  outboxIds: readonly string[],
): Promise<number> {
  if (outboxIds.length === 0) return 0;
  const now = new Date().toISOString();
  const rows = await tx.update(educationOutbox).set({
    processed_at: now,
    lease_token: null,
    leased_until: null,
    last_error: "migrated:background_tasks",
  }).where(
    and(
      isNull(educationOutbox.processed_at),
      // 逐条匹配，避免把未在本批迁移的行一起标记。
      or(...outboxIds.map((id) => eq(educationOutbox.id, id))),
    ),
  ).returning({ id: educationOutbox.id });
  return rows.length;
}
