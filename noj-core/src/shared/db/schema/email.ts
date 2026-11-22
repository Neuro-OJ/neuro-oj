import {
  check,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** 邮件回调归一化事件；只保存收件地址哈希和脱敏展示值。 */
export const emailDeliveryEvents = pgTable(
  "email_delivery_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    provider_event_id: text("provider_event_id").notNull(),
    event_type: text("event_type").notNull(),
    recipient_hash: text("recipient_hash").notNull(),
    recipient_masked: text("recipient_masked").notNull(),
    reason_code: text("reason_code"),
    reason: text("reason"),
    occurred_at: text("occurred_at").notNull(),
    received_at: text("received_at").notNull(),
  },
  (table) => ({
    providerEventUnique: unique("email_delivery_events_provider_event_unique")
      .on(table.provider, table.provider_event_id),
    recipientIdx: index("idx_email_delivery_events_recipient_hash").on(
      table.recipient_hash,
    ),
    occurredIdx: index("idx_email_delivery_events_occurred_at").on(
      table.occurred_at,
    ),
    eventTypeCheck: check(
      "email_delivery_events_event_type_check",
      sql`${table.event_type} IN ('delivery', 'temporary_failure', 'permanent_bounce', 'complaint')`,
    ),
  }),
);

/** 永久退信/投诉抑制清单；cleared_at 非空表示管理员已解除抑制。 */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: text("id").primaryKey(),
    recipient_hash: text("recipient_hash").notNull(),
    recipient_masked: text("recipient_masked").notNull(),
    reason: text("reason").notNull(),
    provider: text("provider").notNull(),
    source_event_id: text("source_event_id").notNull(),
    suppressed_at: text("suppressed_at").notNull(),
    cleared_at: text("cleared_at"),
    cleared_by: text("cleared_by"),
  },
  (table) => ({
    recipientIdx: index("idx_email_suppressions_recipient_hash").on(
      table.recipient_hash,
    ),
    activeUnique: uniqueIndex("email_suppressions_active_recipient_unique")
      .on(table.recipient_hash)
      .where(sql`${table.cleared_at} IS NULL`),
    suppressedAtIdx: index("idx_email_suppressions_suppressed_at").on(
      table.suppressed_at,
    ),
  }),
);
