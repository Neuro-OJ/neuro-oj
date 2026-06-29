# 密码重置（Issue #49）

## Why

Neuro OJ 当前没有自助式密码重置流程——用户忘记密码只能联系管理员手动改密码，运维成本高且用户体验差。需要建立基于邮件令牌的标准密码重置流程：

- 用户输入注册邮箱 → 后端生成短期令牌 → 邮件（含重置链接）发出
- 用户点击邮件链接 → 进入重置页 → 输入新密码 → 后端验令牌并改密
- 全程遵循 OWASP 2025+ 安全规范：防邮箱枚举、令牌哈希存、短期 15 分钟一次性

## What Changes

- **新增 `password_reset_tokens` 表**：id / user_id（FK CASCADE） / token_hash（UNIQUE） / expires_at / used_at / created_at
- **新增 `POST /api/v1/auth/forgot-password`**：接受 email，不区分邮箱是否存在统一返 200（防枚举）；用户存在时生成令牌、INSERT 行、调 `sendPasswordResetEmail()`
- **新增 `POST /api/v1/auth/reset-password`**：接受 token + new_password；单 SQL `UPDATE ... SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`（原子消耗）；affected = 0 → 400 错误；affected = 1 → 更新用户密码
- **新增 `src/lib/resetToken.ts`**：`generateResetToken()` 32 字节 base64url + `hashResetToken()` SHA-256 hex
- **新增 `src/lib/email.ts`**：mock 版 `sendPasswordResetEmail()`，`console.log` 完整记录（生产后续接 Resend/SMTP）
- **新增 `src/services/passwordReset.ts`**：`requestReset(email)` + `resetPassword(token, newPassword)`，复用 `validatePasswordStrength()` 和 `hashPassword()`
- **前端新增 `pages/forgot-password.vue`**：步骤 1，输邮箱 → 显示"邮件已发送"绿色 banner
- **前端新增 `pages/reset-password.vue`**：步骤 2，URL `?token=...` → 输入新密码 + 确认密码 → 跳 `/login?reset=1`
- **前端 `composables/useAuth.ts` 追加**：`forgotPassword(email)` + `resetPassword(token, newPassword)` 两个方法
- **前端 `pages/login.vue` 改动**：删除 `showForgot` stub 弹窗（"功能开发中"），"忘记密码？"改为 NuxtLink；读 `query.reset === "1"` 显示"密码重置成功"绿色 banner
- **前端 `middleware/auth.ts` 加白名单**：`forgot-password` / `reset-password` 路径免登录守卫

## Capabilities

### Modified Capabilities
- `user-auth`：扩展为含密码重置端点；新增 `password_reset_tokens` 相关要求
- `database-schema`：新增 `password_reset_tokens` 表规范

## Impact

- **noj-core**：1 个新表 + 迁移 0007；2 个新端点（forgot-password、reset-password）；1 个新 lib（resetToken、email）；1 个新 service（passwordReset）
- **noj-ui**：2 个新页面（forgot-password、reset-password）；1 个 composable 扩展；login.vue 改动；middleware 白名单
- **OpenSpec**：user-auth、database-schema 两个 spec 的更新
- **数据库**：执行 migration 0007 新增 password_reset_tokens 表
- **环境变量**：本 PR 不新增（控制台 mock 不需 SMTP）；后续接邮件服务时需 RESEND_API_KEY 等
- **安全**：防邮箱枚举、令牌哈希存、15 分钟 TTL、一次性消耗（原子 SQL）、复用现有密码强度校验
