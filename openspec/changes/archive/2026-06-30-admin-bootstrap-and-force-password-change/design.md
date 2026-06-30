## 1. 数据库 Schema

### 1.1 `users.must_change_password` 字段

新增列：

```sql
ALTER TABLE users
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
```

- `NOT NULL DEFAULT false`：存量用户默认 `false`，向前兼容不影响登录
- 写入位置：用户注册 → `false`；`ensureBootstrapAdmin()` 创建 → `true`；
  `changePassword()` 成功后 → `false`
- 读取位置：`loginUser()` 写入 JWT；`authMiddleware` 读取并拦截；前端
  `useAuth` 持久化

### 1.2 Schema 更新（Drizzle）

```ts
export const users = pgTable("users", {
  // ... 既有字段
  must_change_password: boolean("must_change_password").notNull().default(false),
});
```

## 2. JWT Payload 扩展

`TokenPayload` 接口新增字段：

```ts
export interface TokenPayload {
  sub: string;
  role: string;
  must_change_password: boolean;   // 新增，与 DB 列名对齐
  jti?: string;
}
```

`signToken()` 调用方必须传入 `must_change_password`（TypeScript 编译期保证）。
`verifyToken()` 透传该字段到 `authMiddleware`。

## 3. 引导管理员创建流程

### 3.1 触发条件

`ensureBootstrapAdmin()` 在以下条件**全部满足**时执行创建：

1. `users` 表中不存在 `id='0'` 的 root 之外的 admin（`role='admin' AND id != '0'`）
2. 环境变量 `ADMIN_EMAIL` **未** 设置（让 `ensureAdminFromEnv()` 优先）

> 若设置了 `ADMIN_EMAIL` 但对应用户不存在，沿用现有逻辑打印警告，不创建
> 临时管理员（避免覆盖运维人员的明确意图）。

### 3.2 创建逻辑

```ts
async function ensureBootstrapAdmin(): Promise<void> {
  const db = getDb();

  // 已存在可登录 admin（含本次 seed 刚创建的）则跳过
  const [adminCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(and(eq(users.role, "admin"), not(eq(users.id, "0"))));
  if (Number(adminCount?.count ?? 0) > 0) return;

  const password = generateStrongPassword();  // 24 字符 base64url
  const { hashPassword } = await import("../src/lib/password.ts");

  await db.insert(users).values({
    id: crypto.randomUUID(),
    username: "admin",
    email: "admin@noj.local",
    password_hash: await hashPassword(password),
    role: "admin",
    must_change_password: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).onConflictDoNothing();

  console.log(`
⚠ 已创建临时引导管理员（首次登录后必须修改密码）：
  username: admin
  email:    admin@noj.local
  password: ${password}
`);
}
```

### 3.3 密码生成

`generateStrongPassword()`：

- 24 字符 base64url（URL-safe，不含 `+/=`）
- 使用 `crypto.getRandomValues(new Uint8Array(24))` 生成 24 字节随机数
- 经 base64url 编码后截断到前 24 字符（取 24 字节而非理论最小 18 字节，
  目的是让每个输出字符都来自独立随机源）
- 24 字符 × 6 bits = 144 bits 熵，满足 ≥12 位 + 大小写字母 + 数字的强度规则

## 4. 中间件拦截

### 4.1 白名单

`PASSWORD_CHANGE_WHITELIST` 仅包含两个端点：

```ts
const PASSWORD_CHANGE_WHITELIST = [
  "/api/v1/auth/change-password",
  "/api/v1/auth/me",            // 允许前端查当前用户信息
];
```

> **关于 `/api/v1/auth/logout`**：评审修复 M5 后已移除出白名单。
> logout 端点是 no-op stub（路由层不挂 authMiddleware），服务端无状态，
> 客户端自行清 Cookie。强制改密状态下用户不需要走后端 logout
> （Nitro 代理本地清 Cookie 即可），缩小攻击面。

### 4.2 拦截逻辑

```ts
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "未提供认证令牌" }, 401);
  }

  const token = authHeader.slice(7);
  let payload: TokenPayload;
  try {
    payload = await verifyToken(token);
  } catch {
    return c.json({ error: "认证令牌无效或已过期" }, 401);
  }

  c.set("userId", payload.sub);
  c.set("userRole", payload.role);
  c.set("mustChangePassword", payload.must_change_password);

  // 必须改密：非白名单路径直接拒绝
  if (payload.must_change_password &&
      !PASSWORD_CHANGE_WHITELIST.includes(c.req.path)) {
    return c.json({
      error: "请先修改密码",
      code: "PASSWORD_CHANGE_REQUIRED",
    }, 403);
  }

  await next();
}
```

### 4.3 状态写入位置

`c.set("mustChangePassword", payload.must_change_password)` 写入 camelCase
（与 Hono `c.get` 风格一致）；JWT claim 使用 snake_case（与 DB 列名一致）。

## 5. 修改密码端点

### 5.1 路由

```
POST /api/v1/auth/change-password
Headers: Authorization: Bearer <jwt>
Body: {
  "old_password": "string (optional for bootstrap admin)",
  "new_password": "string"
}
```

### 5.2 服务层

```ts
export async function changePassword(
  userId: string,
  oldPassword: string | undefined,
  newPassword: string,
): Promise<UserResponse> {
  const db = getDb();

  const [user] = await db.select().from(users)
    .where(eq(users.id, userId)).limit(1);
  if (!user) throw new UnauthorizedError("用户不存在");

  // 校验旧密码（root 用户不可登录，理论上不会被调用，做防御性检查）
  if (user.id !== "0") {
    if (!oldPassword) throw new BadRequestError("缺少原密码");
    const valid = await comparePassword(oldPassword, user.password_hash);
    if (!valid) throw new UnauthorizedError("原密码错误");
  }

  // 复用注册时的强度规则
  validatePasswordStrength(newPassword, user.username, user.email);

  const now = new Date().toISOString();
  await db.update(users).set({
    password_hash: await hashPassword(newPassword),
    must_change_password: false,
    updated_at: now,
  }).where(eq(users.id, userId));

  return { ...toUserResponse({ ...user, must_change_password: false, updated_at: now }) };
}
```

### 5.3 响应

成功：200 `{ data: { ...user, must_change_password: false } }`

失败：
- 400 — 缺少 `old_password`、新密码强度不足
- 401 — `old_password` 错误
- 403 — `must_change_password` 检测异常（理论上不应发生）

## 6. 前端路由守卫

### 6.1 守卫位置

`noj-ui/middleware/auth.ts`（已有登录守卫）：

```ts
export default defineNuxtRouteMiddleware((to) => {
  const { user } = useAuth();
  if (!user.value) return;  // 未登录由后续 middleware 处理

  if (user.value.must_change_password &&
      to.path !== "/change-password") {
    return navigateTo("/change-password");
  }
});
```

### 6.2 登录分流

`composables/useAuth.ts` 的登录成功后逻辑：

```ts
if (user.must_change_password) {
  await navigateTo("/change-password");
} else if (redirectPath) {
  await navigateTo(redirectPath);
} else {
  await navigateTo("/");
}
```

## 7. 关键安全设计

1. **创建时即置位**：`must_change_password=true` 不可绕过——即使 seed 反复跑
   也只创建一次
2. **强制改密前拒绝所有非白名单操作**：含 `/api/v1/submissions`、
   `/api/v1/problems`、`/api/v1/admin/*` 等所有受保护路径
3. **白名单最小化**：只放行"改密 + 看自己信息"（评审修复 M5 后移除 logout，缩小攻击面）
4. **旧密码校验**：`change-password` 要求提供 `old_password`，防止 CSRF/会话
   劫持后被改密
5. **改密成功后清 Cookie**：跳 `/login?reason=password_changed`，让旧 JWT 不再
   被前端使用（虽然后端 24h 内仍接受）
6. **种子幂等**：`ensureBootstrapAdmin()` 检查可登录 admin 已存在则跳过，覆盖
   `must_change_password=true` 残留情况
7. **速率限制**：`change-password` 纳入 issue #73 的 IP 维度限流

## 8. 错误码与常量命名

| 名称                            | 用途                       |
| ------------------------------- | -------------------------- |
| `must_change_password`          | DB 列、JWT claim、API 字段 |
| `mustChangePassword`            | Hono context `c.set/get`   |
| `PASSWORD_CHANGE_WHITELIST`     | 中间件白名单常量           |
| `PASSWORD_CHANGE_REQUIRED`      | 错误码（403）              |
| `PASSWORD_CHANGE_WHITELIST`     | 路由白名单路径             |
| `MIN_PASSWORD_LENGTH = 12`      | 复用现有常量               |
| `generateStrongPassword()`      | seed 脚本内私有函数        |

## 9. 测试矩阵

| 测试                                            | 覆盖                                     |
| ----------------------------------------------- | ---------------------------------------- |
| `auth_change_password_test.ts`                  | 服务层：正常/旧密码错/弱密码拒绝         |
| `routes/auth_change_password_test.ts`           | 路由：200/400/401                        |
| `auth_must_change_test.ts`                      | 中间件：拦截/白名单放行                  |
| `seed_bootstrap_admin_test.ts`                  | seed：幂等/已存在 admin 跳过/打印凭证    |
| `tests/00_migrate_test.ts`                      | 迁移：列存在且默认 `false`               |

## 10. 与其他 Issue 的关系

- **issue #73（登录速率限制）**：互补——#73 防"暴力破解登录"，本 issue 防"会话
  劫持后长期潜伏"。`change-password` 端点同时纳入 #73 限流范围
- **issue #63（U/P 题库 + root 用户）**：`root` 用户的"不可登录"语义保持不变；
  本 issue 引入的 `admin`（`must_change_password=true`）与 root 是两个独立
  账号，互不干扰