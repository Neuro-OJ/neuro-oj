## Context

当前 noj-core 权限系统是二进制字符串比较：`users.role TEXT DEFAULT 'user'`，所有授权检查为硬编码 `userRole === "admin"`（出现 27+ 处）。无 TypeScript 类型安全、无粒度控制、无集中管理点。

Phase 2 比赛系统需要 `contest_organizer`、`problem_setter`、`moderator` 等中间角色。现有架构每增加一个角色需要触达所有硬编码位置，不可持续。

### 约束

- **向前兼容**：`users.role` 列和 JWT `role` claim 保留（展示/过渡用），权限判断改用 `is_admin` 布尔 claim
- **无外部依赖**：不引入 Casbin 等权限框架，直接查 PostgreSQL
- **渐进迁移**：新代码用 RBAC，旧代码逐步替换，不阻塞现有功能

## Goals / Non-Goals

**Goals:**
- 角色-权限的数据库建模（roles、permissions、role_permissions、user_roles）
- 角色继承（单父链，递归 CTE 展开）
- `is_admin` 标记实现管理员的隐式全权限（不参与权限计算）
- `is_default` 标记实现注册时的自动角色分配
- `is_system` 标记保护预置角色不被误删
- `checkPermission(userId, permission)` 函数：一次查询返回用户所有权限，TS 端 `Set.has()` 精确匹配
- 管理员后台角色 CRUD + 权限勾选编辑器，带服务端约束防锁死
- JWT `role` 字段保留为 admin fast path，跳过 DB 查询

**Non-Goals:**
- 不实现多父继承
- 不实现权限 glob/regex 匹配（纯精确 `resource:action` 字符串）
- 不引入 Redis 缓存（当前规模下 PG 直查足够）
- 不删除 `users.role` 列（向后兼容，后续版本清理）
- 不实现动态权限规则（ABAC）
- 不实现前端角色守卫的细粒度迁移（仅 admin 角色判断）

## Decisions

### 1. 数据模型：四表 + 标记位

选择单表 `roles` 配合 `is_admin`/`is_default`/`is_system` 布尔标记，而不是多张专用表或单独列。

**替代方案**：
- A) `roles` 表 + 单独的 `role_permissions` 表 + 代码中硬编码 admin 判断 → 选择此项。代码量最小，`is_admin` 标记消除了 admin 需要显式分配所有权限的麻烦。
- B) 完全用 `role_permissions` 表（admin 也需要显式分配所有权限）→ 拒绝。admin 每次都要保持权限全选，增加维护负担。
- C) 不用标记位，用独立的 `system_roles` 表 + `admin_roles` 表 → 拒绝。过度设计，三个布尔列足够。

### 2. 继承：单父 + 递归 CTE

```sql
WITH RECURSIVE resolved AS (
  SELECT r.id, r.is_admin, r.parent_id
  FROM roles r JOIN user_roles ur ON ur.role_id = r.id
  WHERE ur.user_id = $1
  UNION ALL
  SELECT r.id, r.is_admin, r.parent_id
  FROM roles r JOIN resolved rr ON r.id = rr.parent_id
)
SELECT DISTINCT p.resource || ':' || p.action AS perm
FROM resolved rr
JOIN role_permissions rp ON rp.role_id = rr.id
JOIN permissions p ON p.id = rp.permission_id
WHERE rr.is_admin = false;  -- admin 不展开权限
```

**替代方案**：
- A) 递归 CTE（无深度限制）→ 选择此项。用户说的对，限制深度反而要多写验证代码，递归 CTE 天然支持任意深度，实际继承链不会超过 3 层。
- B) 手动限制深度（`WHERE depth < 3`）→ 拒绝。多余的约束。
- C) 预计算：所有角色的展开权限存入 Redis SET → 拒绝。Phase 2 前不需要缓存层。

### 3. 权限检查：一次取出全量，TS 端 `Set.has()`

```typescript
async function getUserPermissions(userId: string): Promise<Set<string>> {
  // 递归 CTE 查询
  const rows = await db.execute(sql`...`);
  return new Set(rows.map(r => r.perm));
}

// 检查
const perms = await getUserPermissions(userId);
if (perms.has("problem:create_p")) { ... }
```

**替代方案**：
- A) 每次检查一次 SQL（`SELECT 1 WHERE ... LIMIT 1`）→ 拒绝。一个 HTTP 请求可能检查多个权限，每次往返增加延迟。
- B) SQL 返回整个 Set → 选择此项。一次往返，请求生命周期内通过 `c.set("userPerms", perms)` 复用。
- C) JWT 嵌入全部权限 → 拒绝。权限变更不即时生效；权限多时 token 体积过大。

### 4. 权限中间件：统一为两个函数，基于 `isAdmin` 而非角色名

JWT 中新增 `is_admin` 布尔 claim，权限判断不依赖角色名称（角色名可被管理员重命名）。

```typescript
// src/lib/jwt.ts — TokenPayload
export interface TokenPayload {
  sub: string;
  role: string;          // 主要角色名，展示/向前兼容
  is_admin: boolean;     // 是否拥有 is_admin=true 的角色
  must_change_password?: boolean;
  jti?: string;
}

// src/middleware/auth.ts — AuthEnv 注入
export interface AuthEnv {
  Variables: {
    userId: string;
    userRole: string;      // 向前兼容
    isAdmin: boolean;      // 权限 fast path 以此为准
    mustChangePassword: boolean;
    jti?: string;
  };
}
```

**只需两个中间件函数：**

```typescript
// 管理路由组：纯 JWT 检查，零 DB 查询（替代原 adminMiddleware）
export function requireAdmin() {
  return async (c: Context, next: Next) => {
    if (!c.var.isAdmin) throw new ForbiddenError("需要管理员权限");
    await next();
  };
}

// 通用权限：isAdmin fast path → DB fallback
export function requirePermission(permission: string) {
  return async (c: Context, next: Next) => {
    if (c.var.isAdmin) return next();          // ← 不依赖角色名
    const perms = await resolvePermissions(c);  // 请求级缓存，同请求零额外 DB
    if (!perms.has(permission)) {
      throw new ForbiddenError("权限不足");
    }
    await next();
  };
}
```

使用方式：

```typescript
// 管理路由组
router.use("*", authMiddleware, requireAdmin());

// 细粒度
router.post("/", authMiddleware, requirePermission("problem:create"), handler);
```

一次请求内多次权限检查时，`resolvePermissions()` 只查一次 DB，后续走 `c.get("userPerms")` 缓存。

登录时 `is_admin` 从 `user_roles` + `roles.is_admin` 推导，不依赖名称：

```typescript
const roleRows = await db
  .select({ name: roles.name, is_admin: roles.is_admin, is_default: roles.is_default })
  .from(userRoles)
  .innerJoin(roles, eq(roles.id, userRoles.role_id))
  .where(eq(userRoles.user_id, user.id));

const token = await signToken({
  sub: user.id,
  role: roleRows.find(r => r.is_admin)?.name
     ?? roleRows.find(r => r.is_default)?.name
     ?? "user",
  is_admin: roleRows.some(r => r.is_admin),
});
```

如果 admin 被降级：旧 JWT 中 `is_admin` 仍为 `true`，但 `requirePermission` 绕不过 — DB 查询不含 admin 角色，`perms.has(permission)` 返回 `false` 会拒绝实际无权操作。**DB 仍然是最终权威。**

**替代方案**：
- A) 依赖角色名 `=== "admin"` → 拒绝。角色名可被管理员重命名，不应该作为机器判断依据。
- B) 依赖 `users.role` 列 → 拒绝。用户可能有多个角色，单列无法表达。`is_admin` 布尔 claim 从 RBAC 表实时推导，与角色名解耦。

### 5. 角色编辑器约束（防锁死）

服务端强制规则，不依赖前端校验：

- `is_system=true` → 不可删除、不可改名、不可修改 `is_admin`/`is_default`
- `is_admin=true` 的角色必须始终至少存在一个
- `is_default=true` 的角色必须始终至少存在一个
- 管理员不能移除自己的最后一个角色
- 最后一名 `is_admin=true` 角色的拥有者不能被剥夺该角色

**前端约束**：
- `is_admin=true` 的角色 → 权限勾选区域**不可见**，显示提示"管理员角色隐式拥有所有权限，无需单独配置"
- 继承自父角色的权限 → 灰色 🔒 标记，复选框 disabled，不可取消
- 额外分配的权限 → 正常勾选，可自由增删

### 6. 权限检查调用分层

一次 HTTP 请求中，权限检查有三个调用层次，共享请求级缓存：

```
authMiddleware → 注入 isAdmin
    │
    ├─ requireAdmin()          纯 JWT，零 DB
    │   └─ 用于 /api/v1/admin/* 路由组
    │
    ├─ requirePermission("x")  中间件（isAdmin fast path | DB）
    │   └─ 用于非 admin 路由的精确权限拦截
    │
    └─ checkPermission(c, "x") / assertPermission(c, "x")
        工具函数（isAdmin fast path | DB）
        └─ 用于 handler/service 内部的条件判断或断言
```

`resolvePermissions(c)` 实现请求级缓存：

```typescript
async function resolvePermissions(c: Context): Promise<Set<string>> {
  let perms = c.get("userPerms") as Set<string> | undefined;
  if (perms) return perms;                    // 同请求第二次调用 → 直接返回
  perms = await getUserPermissions(c.var.userId);  // 首次调用 → 查 DB
  c.set("userPerms", perms);                  // 写入上下文
  return perms;
}
```

同一请求内多次权限检查（如 handler 中检查完 `problem:create` 又检查 `problem:create_p`）只有第一次触发 DB 查询。`authMiddleware` 本身完全不变——它只管从 JWT 取 `is_admin` 放到 `c.var.isAdmin`。

### 7. 权限定义粒度

约 22 个权限，精确 `resource:action` 字符串，无 glob：

```
problem:create, problem:create_p, problem:read,
problem:write_own, problem:write_any,
problem:delete_own, problem:delete_any,
problem:package_manage_own, problem:package_manage_any,
submission:create, submission:read_own, submission:read_all,
submission:rejudge,
user:read_profile, user:search, user:manage,
category:read, category:manage,
system:settings, system:judge_images, system:audit_logs, system:ip_bans
```

### 8. 迁移策略

```
Phase 1（本 change）:
  1. 创建 4 张 RBAC 表 + migration
  2. Seed：admin 角色（is_admin=true）+ user 角色（is_default=true）+ 22 个权限定义
  3. 数据迁移：users.role='admin' → user_roles 关联 admin；users.role='user' → user_roles 关联 user
  4. 保留 users.role 列不动
  5. 实现 getUserPermissions() + checkPermission()
  6. 管理员后台角色编辑器
  7. 将现有硬编码检查替换为 checkPermission()（可分批）

Phase 2（后续）:
  8. 引入 contest_organizer 等新角色
  9. 删除 users.role 列
```

## Risks / Trade-offs

- **[风险] admin fast path 与 DB 不一致**：admin 被降级后 JWT 中 `is_admin` 仍为 `true` → `requireAdmin()` 会放行受 `/api/v1/admin/*` 保护的路由，但 `requirePermission()` 会查 DB 并拒绝实际无权操作。极端场景需要即时失效可通过 jti 黑名单强制重登。
- **[风险] 递归 CTE 性能**：角色数和继承深度极小（< 10 角色，< 3 层），CTE 在索引支持下 < 1ms，不构成风险。
- **[风险] `PATCH /users/:id/role` BREAKING**：现有 API 接受 `{ role: "admin"|"user" }` 字符串，改为接受 `{ role_id: UUID }`。旧客户端会收到 400。需要同步更新 noj-ui。
- **[权衡] 不引入 Redis 缓存**：当前 QPS < 10，PG 直查完全够用。未来大规模比赛时可以在中间件插入 Redis 缓存层，`getUserPermissions` 接口不变。
