# 密码重置 — 设计方案

## 1. 安全模型

| 风险 | 防御 |
|------|------|
| 邮箱枚举（探测注册邮箱） | `POST /forgot-password` 不区分邮箱是否存在统一返 200 + 同一消息 |
| 令牌泄漏（邮件被截获） | 令牌 URL 仅 15 分钟有效；DB 存 SHA-256 哈希，URL 传明文（OWASP 接受） |
| 重放攻击 | 一次性消耗：`UPDATE ... SET used_at = now() WHERE used_at IS NULL`，affected = 0 → 拒绝 |
| 并发消耗 | 单 SQL 原子操作，PostgreSQL 行级锁；首个 UPDATE 成功，其余 affected = 0 |
| 弱密码 | 复用 `validatePasswordStrength()`（≥12 字符 + 大小写字母 + 数字） |
| 速率限制 | 本 PR 不实现（与现有登录失败防枚举一致，无 IP 封禁/CAPTCHA，CLAUDE.md 已知限制） |
| 过期 token | expires_at 检查在 SQL `WHERE expires_at > now()`，无应用层时间比较 |

## 2. 数据流

### 请求重置流程

```
客户端 → POST /api/v1/auth/forgot-password { email }
       ↓
Route 层：parseJsonBody, 校验 email 非空
       ↓
Service.requestReset(email):
  1. (可选) 邮箱格式校验
  2. db.select(users).where(email=email) → user | null
  3. user 为 null → 直接 return (响应统一)
  4. user 存在：
     - token = generateResetToken()  // 32 字节 base64url
     - tokenHash = hashResetToken(token)  // SHA-256 hex
     - db.insert(passwordResetTokens).values({
         id: uuid, user_id, token_hash: tokenHash,
         expires_at: now + 15min, used_at: null, created_at: now
       })
     - sendPasswordResetEmail(email, resetLink)  // mock: console.log
  5. return { ok: true, message: "如果该邮箱已注册，您将收到一封密码重置邮件" }
```

### 重置密码流程

```
客户端 → POST /api/v1/auth/reset-password { token, new_password }
       ↓
Route 层：parseJsonBody, 校验字段非空
       ↓
Service.resetPassword(token, newPassword):
  1. validatePasswordStrength(newPassword)  // 复用，失败 → throw BadRequestError
  2. tokenHash = hashResetToken(token)
  3. db.transaction:
     a. UPDATE password_reset_tokens
        SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id
     b. 若 affected = 0 → throw BadRequestError("重置令牌无效或已过期")
     c. UPDATE users
        SET password_hash = hashPassword(newPassword), updated_at = now()
        WHERE id = $user_id
  4. return { ok: true, message: "密码重置成功，请使用新密码登录" }
```

## 3. 关键 SQL

### 令牌消耗（原子）

```sql
UPDATE password_reset_tokens
SET used_at = now()
WHERE token_hash = $1
  AND used_at IS NULL
  AND expires_at > now()
RETURNING user_id, expires_at;
```

- `RETURNING` 在 Drizzle 中通过 `.returning({ userId: ... })` 获取
- affected rows = 0 → 令牌无效（不存在 / 已用 / 已过期）
- affected rows = 1 → 拿到 user_id，进入下一步改密码
- 并发场景：PostgreSQL 行级锁，第二个 UPDATE 等待后命中 `used_at IS NULL` 失败

### 链接生成

前端在 reset-password 页面用 `route.query.token` 调后端。开发环境链接：
`http://localhost:3000/reset-password?token=<base64url-encoded>`

生产环境由 `APP_URL` 环境变量提供（暂未实现 → 硬编码 `http://localhost:3000`，后续 issue 提取）

## 4. Mock 邮件 Runbook

控制台输出格式（开发）：

```
[email-mock] password reset { to: "user@example.com", link: "http://localhost:3000/reset-password?token=AbC...XyZ", expiresIn: "15 minutes" }
```

测试流程：
1. `POST /api/v1/auth/forgot-password { "email": "user@example.com" }` → 200
2. 查看后端 stdout，复制 link
3. 浏览器访问 `http://localhost:3000/reset-password?token=...`
4. 输入新密码（≥12 字符 + 大小写数字）→ 跳 `/login?reset=1` 成功 banner
5. 用新密码 `POST /api/v1/auth/login` → 200 + JWT

## 5. TTL 选择理由

issue #49 描述明确要求 15 分钟，与 OWASP 2025+ 建议（密码重置 ≤ 15 分钟）一致：

- 太短（5 分钟）：用户邮件延迟/收件慢时容易过期，UX 差
- 太长（1 小时+）：令牌泄漏窗口大，安全风险高
- 15 分钟：平衡 UX 与安全

## 6. 错误响应

| 场景 | HTTP | 错误消息 |
|------|------|----------|
| 缺少 email 字段 | 400 | "缺少字段 email" |
| 缺少 token 字段 | 400 | "缺少字段 token" |
| 缺少 new_password 字段 | 400 | "缺少字段 new_password" |
| 弱密码 | 400 | "密码至少 12 位，需包含大小写字母和数字" |
| 密码与用户名/邮箱相同 | 400 | "密码不能与用户名或邮箱相同" |
| 令牌无效/过期/已用 | 400 | "重置令牌无效或已过期" |

登录失败仍按 CLAUDE.md 现有约定（统一防枚举 "用户名或密码错误"），不与本 PR 冲突。

## 7. 已知边界

- 本 PR **不**实现真实邮件发送（仅控制台 mock）
- 本 PR **不**实现 rate limiting
- 本 PR **不**清理过期 token（DB 长期累积，可后续 lazy cleanup）
- 本 PR **不**实现 APP_URL 环境变量（生产部署时再提取）
- token URL 含明文但短期有效 + HTTPS 保护 + DB 存哈希，OWASP 2025+ 接受
