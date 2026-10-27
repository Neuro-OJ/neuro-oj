import { check, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accountNotifications } from "./community.ts";

/** 邮件投递游标独立于通知已读状态；失败持久重试，撤权后停止发送。 */
export const educationNotificationEmails = pgTable(
  "education_notification_emails",
  {
    notification_id: text("notification_id").primaryKey().references(() =>
      accountNotifications.id
    ),
    state: text("state").$type<"pending" | "sent" | "skipped">().notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    available_at: text("available_at").notNull(),
    lease_token: text("lease_token"),
    leased_until: text("leased_until"),
    completed_at: text("completed_at"),
    last_error: text("last_error"),
  },
  (t) => ({
    stateCheck: check(
      "education_notification_emails_state_check",
      sql`${t.state} IN ('pending', 'sent', 'skipped')`,
    ),
    attemptsCheck: check(
      "education_notification_emails_attempts_check",
      sql`${t.attempts} >= 0`,
    ),
    pendingIdx: index("idx_education_notification_emails_pending").on(
      t.state,
      t.available_at,
      t.leased_until,
    ),
  }),
);
