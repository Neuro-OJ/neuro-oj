/**
 * 持久后台任务表（P4）。
 *
 * 设计约束（交接文档 §4.1）：
 * - 任务事实只在 PostgreSQL：Redis 只作为唤醒提示，允许丢失；
 * - 唯一键按「任务类型 + 目标 + 业务去重键」建立，同键重复登记返回既有任务；
 * - 不同目标分别登记，一个失败目标不阻塞其他目标；
 * - payload 只保存可恢复依据（资源 ID、attempt ID、revision、分页游标），
 *   不保存 eval token、Provider Key、临时签名 URL；
 * - 租约用 `lease_token` + `lease_expiry`，过期可被其他 worker 回收；
 * - 连续失败 20 次转入终态 `failed`，只能由管理员显式重试。
 *
 * 表 owner：runtime。
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";

/** 任务状态机：pending → leased → succeeded / failed。 */
export type BackgroundTaskStatus =
  | "pending"
  | "leased"
  | "succeeded"
  | "failed";

/** 后台任务行。 */
export const backgroundTasks = pgTable(
  "background_tasks",
  {
    id: text("id").primaryKey(),
    /** 任务类型，例如 `evaluation.dispatch` / `search.index` / `education.recompute`。 */
    task_type: text("task_type").notNull(),
    /** 目标归属（如 `submission` / `problem` / `domain`），用于隔离失败目标。 */
    target_kind: text("target_kind").notNull(),
    /** 目标标识（业务资源 ID）。 */
    target_id: text("target_id").notNull(),
    /** 业务去重键；同类型+目标+去重键只保留一条任务。 */
    dedupe_key: text("dedupe_key").notNull().default(""),
    /** payload 结构版本，便于后续演进时拒绝未知版本。 */
    payload_version: integer("payload_version").notNull().default(1),
    /** 可恢复依据；不得包含秘密或临时凭据。 */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull()
      .default({}),
    status: text("status").$type<BackgroundTaskStatus>().notNull().default(
      "pending",
    ),
    /** 下次可领取时刻（ISO 8601）；退避与人工重试都通过它表达。 */
    available_at: text("available_at").notNull(),
    /** 连续失败次数；成功即清零。 */
    failure_count: integer("failure_count").notNull().default(0),
    /** 当前租约持有者；无租约为 null。 */
    lease_token: text("lease_token"),
    /** 租约持有者标识（worker 实例名），仅用于诊断，不参与授权。 */
    lease_owner: text("lease_owner"),
    /** 租约到期时刻（ISO 8601）；到期后可被其他 worker 回收。 */
    lease_expiry: text("lease_expiry"),
    /** 最近一次处理结果摘要（脱敏）。 */
    last_result: jsonb("last_result").$type<Record<string, unknown>>(),
    /** 最近一次脱敏错误信息。 */
    last_error: text("last_error"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    /** 完成（成功或终态失败）时刻。 */
    finished_at: text("finished_at"),
  },
  (table) => ({
    statusCheck: check(
      "background_tasks_status_check",
      sql`${table.status} IN ('pending', 'leased', 'succeeded', 'failed')`,
    ),
    failureCountCheck: check(
      "background_tasks_failure_count_check",
      sql`${table.failure_count} >= 0`,
    ),
    payloadVersionCheck: check(
      "background_tasks_payload_version_check",
      sql`${table.payload_version} >= 1`,
    ),
    /** 去重键唯一：同一业务事实不会重复登记任务。 */
    dedupeUnique: unique("background_tasks_dedupe_unique").on(
      table.task_type,
      table.target_kind,
      table.target_id,
      table.dedupe_key,
    ),
    /** 领取扫描：按状态 + 可领取时刻找候选。 */
    claimIdx: index("idx_background_tasks_claim").on(
      table.status,
      table.available_at,
    ),
    /** 目标隔离与运维查询。 */
    targetIdx: index("idx_background_tasks_target").on(
      table.target_kind,
      table.target_id,
    ),
    /** 租约回收扫描。 */
    leaseIdx: index("idx_background_tasks_lease").on(
      table.status,
      table.lease_expiry,
    ),
  }),
);

/** 任务行类型。 */
export type BackgroundTaskRow = typeof backgroundTasks.$inferSelect;
/** 新任务插入类型。 */
export type NewBackgroundTaskRow = typeof backgroundTasks.$inferInsert;
