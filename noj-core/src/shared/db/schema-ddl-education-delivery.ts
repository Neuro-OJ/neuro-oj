/** 教学邮件持久投递 DDL，不保存邮箱、成绩或反馈正文。 */
export const EDUCATION_DELIVERY_DDL = [
  `CREATE TABLE IF NOT EXISTS education_notification_emails (
    notification_id TEXT PRIMARY KEY REFERENCES education_notifications(id),
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    lease_token TEXT,
    leased_until TEXT,
    completed_at TEXT,
    last_error TEXT,
    CONSTRAINT education_notification_emails_state_check
      CHECK (state IN ('pending', 'sent', 'skipped')),
    CONSTRAINT education_notification_emails_attempts_check CHECK (attempts >= 0)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_education_notification_emails_pending
    ON education_notification_emails (state, available_at, leased_until)`,
];

/** 测试清理同步包含邮件投递状态。 */
export const EDUCATION_DELIVERY_TABLES = [
  "education_notification_emails",
] as const;
