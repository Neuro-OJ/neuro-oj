CREATE TABLE IF NOT EXISTS check_ins (
  id TEXT PRIMARY KEY,
  -- ON DELETE CASCADE（评审 M2）：用户被删除时一并清理签到记录
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checkin_date TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS check_ins_user_date_unique ON check_ins (user_id, checkin_date);
