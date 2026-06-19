## Why

当前 noj-core 仅有基础设施层（数据库连接、Redis MQ），`users` 表已定义但没有任何用户注册/登录/认证机制。Phase 0 需要用户系统作为后续所有业务功能（题目管理、代码提交）的前置依赖——没有用户系统，无法追踪提交归属、无法进行权限控制。

## What Changes

- 新增 `POST /api/v1/auth/register` — 用户注册端点
- 新增 `POST /api/v1/auth/login` — 用户登录端点，返回 JWT
- 新增 `GET /api/v1/auth/me` — 获取当前用户信息（需认证）
- 新增 JWT 认证中间件，保护需要认证的路由
- 新增密码哈希（bcryptjs）和 JWT 签发/验证（jose）库
- 新增 `AppError` 错误类层次，用于统一错误处理

## Capabilities

### New Capabilities

- `user-auth`: 用户注册、登录、JWT 认证。包含三个 REST 端点（register/login/me）、JWT 中间件、密码哈希和令牌管理。

### Modified Capabilities

<!-- 本次不修改现有 spec -->

## Impact

- **新增依赖**: `bcryptjs` (npm), `jose` (npm)
- **新增文件**: `src/lib/errors.ts`, `src/lib/password.ts`, `src/lib/jwt.ts`, `src/middleware/auth.ts`, `src/services/auth.ts`, `src/routes/auth.ts`, `src/types/auth.ts`
- **修改文件**: `deno.json`, `src/app.ts`
- **不影响**: `users` 表结构已存在，无需数据库迁移
- **环境变量**: 新增 `JWT_SECRET`（必需）和 `JWT_EXPIRES_IN`（可选，默认 24h）
