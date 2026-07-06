## Context

NOJ 现有用户系统（issue #99 settings / #95 私信 / #84 榜单）都假设用户"能用就用、不能用就走"，缺少运营方主动拦截恶意行为的能力。`rateLimitEnv.ts` 已实现 IP 维度登录限流（issue #73），但**仅限流不封禁**：超过阈值后只是延迟，不返回 403。

`src/db/schema-ddl.ts` 维护一份**手写 DDL**（与 Drizzle schema 并行），PGlite 测试启动 + issue #99 settings 等需要时使用。issue #103 reviewer 警告这两份 schema 存在 drift 风险，本 PR 沿用 issue #75 (`must_change_password`) 与 issue #95 (conversations) 的样板同步修改。

JWT payload 当前不含 `banned` 字段（与 `must_change_password` 同模式——只用于强制改密流程），banned 状态需 DB 查询保证实时性。`authMiddleware` 已有 `must_change_password` 白名单机制（`PASSWORD_CHANGE_WHITELIST`），banned 检查沿用相同白名单模式。

`getClientIp()` 已在 `rateLimitEnv.ts:53` 实现 X-Forwarded-For 解析 + 可信代理白名单，零修改直接复用。

## Goals

- 管理员可维护 IP / CIDR 黑名单（新增 / 删除 / 列表 + 分页）
- IP 命中黑名单的请求立即返 403 + `IP_BLACKLISTED` 错误码
- 管理员可封禁 / 解封单个用户（带 reason + 可选到期时间）
- 已封禁用户登录返 403 + `USER_BANNED` 错误码（携带 reason / until）
- 已封禁用户的受认证请求同样 403（防止 ban 死锁：login / logout / me 应放行）
- 全栈错误码 + 前端 banner 提示
- 5 个验收项全部满足

## Non-Goals

- IPv6 CIDR 解析
- 完整审计日志表（issue #101）
- 实时通知（WebSocket 推送 ban 状态变更）
- 自动解封 cron（DB 查询天然过滤 `banned_until < now`）
- 黑名单批量导入 / 导出
- 申诉 / 临时解封 token

## Decisions

### 1. 表结构：`ip_bans` 单表 + `users.banned*` 三列

```sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS banned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS banned_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS banned_until text;  -- ISO 8601；NULL = 永久

CREATE TABLE IF NOT EXISTS ip_bans (
  id            TEXT PRIMARY KEY,
  ip_or_cidr    TEXT NOT NULL,             -- 裸 IP (1.2.3.4) 或 CIDR (10.0.0.0/8)
  reason        TEXT NOT NULL DEFAULT '',
  expires_at    TEXT,                      -- ISO 8601；NULL = 永久
  created_at    TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_ip_bans_ip_or_cidr ON ip_bans(ip_or_cidr);
CREATE INDEX IF NOT EXISTS idx_ip_bans_expires_at ON ip_bans(expires_at) WHERE expires_at IS NOT NULL;
```

**三处同步**（沿用 issue #99 settings 模式）：
1. `noj-core/drizzle/0012_ip_bans_and_user_ban.sql`（PG 迁移）
2. `noj-core/src/db/schema.ts`（Drizzle ORM 类型）
3. `noj-core/src/db/schema-ddl.ts`（PGlite 启动 DDL + SCHEMA_INDEXES 数组）

### 2. CIDR 解析：IPv4 手写，零新依赖

`src/lib/cidr.ts`（约 50 行）：
- `ipv4ToInt(ip: string): number` — 字符串 IP → 32-bit int
- `parseCidr(cidr: string): { base: number; mask: number }` — 解析 `10.0.0.0/8` 为 base+mask
- `isBannedIp(clientIp: string, ranges: string[]): boolean` — 主入口：遍历 ranges 匹配

**理由**：OJ 场景几乎都是 IPv4；引入 `npm:ipaddr.js` (~40KB) 收益不抵成本。IPv6-ready 表结构（`ip_or_cidr` 用 TEXT 而非 binary），后续 PR 加 IPv6 解析即可。

### 3. 60s TTL LRU 缓存

`src/lib/banCache.ts`（约 40 行）—— 与 `system-settings.ts` 同模式（in-memory Map + 单 key 失效）：

```typescript
const cache = new Map<string, { value: unknown; expiresAt: number }>();

export async function getCached<T>(key: string, fetcher: () => Promise<T>, ttlMs = 60_000): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const v = await fetcher();
  cache.set(key, { value: v, expiresAt: Date.now() + ttlMs });
  return v;
}

export function invalidateBanCache(userId?: string, ipOrCidr?: string) {
  if (userId) cache.delete(`user:${userId}`);
  if (ipOrCidr) cache.delete(`ip:${ipOrCidr}`);
  if (!userId && !ipOrCidr) cache.clear();
}
```

**理由**：unban 后旧 token 仍有效 60s 属于可接受范围（与 rate-limit 等现有行为一致）；admin 操作后立即生效更重要，故 ban 操作调用 `invalidateBanCache(userId)`。

### 4. 中间件链顺序：banlistMiddleware 在 authMiddleware 之前

```typescript
// app.ts
app.use(banlistMiddleware);   // ① IP 拦截优先
app.use(authMiddleware);      // ② JWT 验证
```

**理由**：IP 黑名单应该最先拦截，被 ban IP 消耗 JWT 验证 CPU 浪费（且 X-Forwarded-For 可能伪造）。

### 5. authMiddleware banned 校验白名单

```typescript
const BAN_WHITELIST = [
  "/api/v1/auth/login",   // 封禁用户登录查 ban 原因
  "/api/v1/auth/logout",  // 永远允许
  "/api/v1/auth/me",      // 查当前状态
];
```

**不放行**：`/api/v1/auth/change-password`（ban 是对账号的全面控制，重置密码不能"自救"）。

### 6. 业务规则（仿 promoteUser 模板）

| 规则 | 说明 |
|------|------|
| 禁止封禁自己 | `currentUserId === targetUserId` 抛 `BadRequestError` |
| 禁止封禁 root | `targetUserId === '0'` 抛 `BadRequestError` |
| 禁止封禁最后一个 admin | 同 `promoteUser` 防护逻辑 |
| 禁止添加 `0.0.0.0/0` | 封整个 IPv4 互联网 → `ValidationError` |
| 禁止重复 IP/CIDR | 查重 → `ConflictError` |
| 审计日志 | `console.log("[admin] actor=... action=... key=... value=...")` 沿用 issue #99 模式 |

### 7. 端点设计

| 方法 | 路径 | body | 响应 |
|------|------|------|------|
| GET | `/api/v1/admin/blacklist?page=&per_page=&keyword=` | — | `{ data: IpBan[], pagination: {...} }` |
| POST | `/api/v1/admin/blacklist` | `{ ip_or_cidr, reason?, expires_at? }` | `{ data: IpBan }` 201 |
| DELETE | `/api/v1/admin/blacklist/:id` | — | 204 |
| PATCH | `/api/v1/admin/users/:id/ban` | `{ reason?, banned_until? }` | `{ data: User }` 200 |
| PATCH | `/api/v1/admin/users/:id/unban` | — | `{ data: User }` 200 |

### 8. 前端策略

- **`/admin/blacklist.vue`**：仿 `categories.vue` 的 CRUD 三件套（顶部"新增"按钮 + AdminModal + AdminTable + 分页 + 删除二次确认）
- **`/admin/users.vue`**：操作列加"封禁 / 解封"按钮（按 `row.banned` 切换文案）；banned 用户 username 列右侧加红色 badge；用 `AdminModal` 输入 reason / banned_until
- **`useAuth.ts`**：`UserResponse` + `SessionData` 加 `banned: boolean` 字段；`fetchUser()` 不变
- **`login.vue`**：增加 `?banned=1&reason=...&until=...` banner 分支（与 `?reset=1` 同款）
- **`admin.vue`**：navItems 加 `{ label: '黑名单管理', to: '/admin/blacklist', icon: Ban }`

### 9. 错误码统一

`ForbiddenError` 已支持可选 `code` 参数（issue #75 引入），无需新建错误类：

| 场景 | 错误类 + code |
|------|---------------|
| IP 在黑名单 | `ForbiddenError("...", "IP_BLACKLISTED")` |
| 用户被封禁 | `ForbiddenError("...", "USER_BANNED")` |
| 重复 IP/CIDR | `ConflictError("IP/CIDR 已存在")` |
| 非法 CIDR | `ValidationError("CIDR 格式无效")` |

## Risks

- **[风险] 60s 缓存过期**：unban 后 60s 内仍可能 403 → 缓解：admin 操作后 `invalidateBanCache()` 立即失效
- **[风险] `0.0.0.0/0` 误添加**：服务拒绝路径已校验；但若 admin 误操作 → 缓解：`BadRequestError` 显式拦截
- **[风险] JWT 长有效期 + banned 未即生效**：旧 token 24h 有效期内可绕过 banned 检查 → 缓解：60s LRU 缓存 + banned 检查在 `authMiddleware` 必走
- **[风险] X-Forwarded-For 伪造**：恶意用户可伪造 IP 绕过黑名单 → 缓解：复用 `getClientIp()` + `TRUSTED_PROXIES` 白名单（生产环境已要求配置）
- **[风险] 自我封禁导致不可恢复**：admin 误把自己 ban → 缓解：`currentUserId === targetUserId` 检查 + root 账户永不可 ban

## Trade-offs

- **IPv4-only**：手写实现 50 行 vs `ipaddr.js` 40KB 依赖。OJ 场景 IPv4 足够，省一个依赖更易维护
- **banned_until 透传 ISO 8601 文本**：与项目其他时间字段一致（不引入 timestamptz）
- **60s LRU**：与 system-settings 一致；TTL 越长查询越省，但 unban 反应越慢
- **不写审计日志表**：沿用 console 模式；issue #101 是独立工作
