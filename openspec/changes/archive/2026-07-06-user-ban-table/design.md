## Context

PR #108 (`admin-ip-blacklist`) 在 `users` 表用三列（`banned / banned_reason / banned_until`）追踪封禁状态。解封后数据被清空，历史不可追溯。`ip_bans` 已用独立表追踪 IP 封禁历史（含 `created_by` 审计），用户封禁应统一为同模式。

迁移 0012 新增的三列从未投入生产使用，直接替换不需要数据迁移。

## Goals / Non-Goals

**Goals:**
- 用 `user_bans` 表替换 `users` 三列
- 提供完整的封禁/解封审计追溯
- 封禁逻辑清晰：最新活跃封禁覆盖旧活跃封禁（方案 A）
- `UserResponse` 仍可查询当前封禁状态（通过 JOIN 或子查询）

**Non-Goals:**
- 不实现自动解封 cron（仍有 60s LRU + `banned_until` 判断）
- 不实现封禁申诉
- 不修改 `ip_bans` 表结构

## Decisions

### 1. `user_bans` 表结构

```sql
CREATE TABLE user_bans (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL DEFAULT '',
  banned_until  TEXT,           -- ISO 8601；NULL = 永久
  banned_at     TEXT NOT NULL,  -- 封禁时间
  banned_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  unbanned_at   TEXT,           -- NULL = 当前活跃封禁
  unbanned_by   TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- 索引：快速查活跃封禁
CREATE INDEX idx_user_bans_active ON user_bans(user_id)
  WHERE unbanned_at IS NULL;

-- 索引：查完整历史
CREATE INDEX idx_user_bans_user ON user_bans(user_id);
```

**理由**：
- 与 `ip_bans` 同模式（独立审计表 + 双向操作人追踪）
- `unbanned_at IS NULL` = 当前活跃封禁——查询效率高（部分索引）
- `banned_by` > `unbanned_by` 两条 FK 指向前后两位操作人
- 一条封禁记录：从 `banned_at` 到 `unbanned_at`（或永久）

### 2. 活跃封禁判定（方案 A：以最新为准）

`banUser()` 调用时：

```typescript
// 1. 关闭已有活跃封禁
await db.update(userBans)
  .set({ unbanned_at: now, unbanned_by: null })
  .where(and(eq(userBans.user_id, targetId), isNull(userBans.unbanned_at)));

// 2. 插入新封禁记录
await db.insert(userBans).values({ ... });

// 3. 失效缓存
invalidateBanCache({ userId: targetId });
```

`getUserBanState()` 读取：

```typescript
const row = await db.select().from(userBans)
  .where(and(eq(userBans.user_id, userId), isNull(userBans.unbanned_at)))
  .limit(1);
if (!row.length) return { banned: false, reason: "", until: null };
return { banned: true, reason: row[0].reason, until: row[0].banned_until };
```

**行为**：任何时候 `user_bans` 中至多有一条记录 `unbanned_at IS NULL`（因为后续封禁会先关闭前一条）。

### 3. `users` 表变化

迁移 0012 在 `users` 表新增的三列 (`banned / banned_reason / banned_until`) 在新迁移 0013 中**直接删除**（未被使用过，无数据损失）：

```sql
ALTER TABLE users DROP COLUMN IF EXISTS banned;
ALTER TABLE users DROP COLUMN IF EXISTS banned_reason;
ALTER TABLE users DROP COLUMN IF EXISTS banned_until;
```

**注意**：0012 和 0013 都是本次 PR 范围内的迁移，尚未合入 main。如果直接改 0012 会更干净——在 0012 中就不加这三列，只建 `user_bans` 表。但考虑到 reviewers 已审查过 0012，建议用新迁移 0013 做替换（清晰表达"改设计"的意图）。

### 4. `UserResponse` 适配

`UserResponse` 中不再有 `banned / banned_reason / banned_until` 直接字段，改为计算字段：

```typescript
interface UserResponse {
  id: string;
  username: string;
  email: string;
  role: string;
  must_change_password: boolean;
  // 封禁状态（从 user_bans 计算，仅 /admin/users 列表需要；/me 由 ban-status 端点提供）
  active_ban?: {
    reason: string;
    banned_until: string | null;
  } | null;
  created_at: string;
  updated_at: string;
}
```

**权衡**：admin 用户列表查询时需要 JOIN 或子查询获取活跃封禁状态。如果 `user_bans` 做 LEFT JOIN 会产生额外的 DB 开销——但管理员列表是低频操作，且 `idx_user_bans_active` 部分索引扫描成本极低。

### 5. 封禁历史端点

新增 `GET /api/v1/admin/users/:id/bans`：

```json
{
  "data": [
    {
      "id": "uuid",
      "reason": "违规提交",
      "banned_until": "2026-12-31T00:00:00Z",
      "banned_at": "2026-07-01T10:00:00Z",
      "banned_by": { "id": "admin-uuid", "username": "admin" },
      "unbanned_at": null,
      "unbanned_by": null
    },
    {
      "id": "uuid",
      "reason": "滥用 API",
      "banned_until": "2026-06-30T00:00:00Z",
      "banned_at": "2026-06-01T10:00:00Z",
      "banned_by": { "id": "admin-uuid", "username": "admin" },
      "unbanned_at": "2026-07-01T00:00:00Z",
      "unbanned_by": { "id": "admin-uuid", "username": "admin" }
    }
  ]
}
```

### 6. 与 `ban-status-endpoint` 的交互

`GET /api/v1/auth/ban-status` 返回格式不变——`user_banned / user_ban_info` 字段仍然来自 `getUserBanState()`，只是底层查询从 `users` 表切换为 `user_bans` 表。

`useBanStatus.ts` / `BanBanner.vue` 无需修改。

## Risks / Trade-offs

- **[风险] 多次封禁但只展示最新原因** — 前端 BanBanner 只显示最新封禁条目的 `reason`，如果 Admin B 设了更短的 `banned_until` 且更简单的原因，旧封禁的原因被覆盖 → 缓解：前端可从 `/admin/users/:id/bans` 查看完整历史（管理用途）
- **[权衡] `UserResponse` 不再扁平化 ban 字段** — 改了 API 契约，依赖 `UserResponse.banned` 的消费方需要改代码 → 缓解：未投入生产，除 noj-ui 外无其他消费方
- **[风险] DB 迁移顺序敏感** — 0012（PR 的原始迁移）加了三列，0013 删掉 → 缓解：0013 用 `DROP COLUMN IF EXISTS` 幂等；如果 CI/CD 按序执行迁移不会有问题

## Migration Plan

1. 新增迁移 0013：CREATE `user_bans` + DROP `users.banned*` 三列
2. `schema-ddl.ts`：同步 PGlite DDL（DELETE 三列 + ADD 新表）
3. `schema.ts`：Drizzle 定义更新
4. `services/users.ts`：`banUser()`/`unbanUser()` 切到 `user_bans`
5. `middleware/auth.ts`：`getUserBanState()` 切到 `user_bans`
6. `services/auth.ts`：`listUsers()`/`toUserResponse()` 适配
7. `routes/admin.ts`：新增 ban 历史端点
8. `types/auth.ts`：`UserResponse` 类型清理
9. `noj-ui/`：`useAuth.ts`、`admin/users.vue` 适配
