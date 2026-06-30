## Purpose

管理后台权限系统规范增量：自动创建引导管理员、强制首次改密，与既有 root 系统
用户机制协同。

## MODIFIED Requirements

### Requirement: 种子脚本可初始化管理员

系统 SHALL 在 `deno task seed` 执行时，依次执行 `ensureRootUser()` 和
`ensureBootstrapAdmin()`。`ensureBootstrapAdmin()` 在不存在"可登录 admin"
（`role='admin' AND id != '0'`）时自动创建一个临时管理员账号
（`username='admin'`, `email='admin@noj.local'`, 24 字符 base64url 随机密码），
并设置 `must_change_password=true`，终端以醒目格式打印临时凭证。

`ensureAdminFromEnv()` 在 `ADMIN_EMAIL` 已设置时仍按既有逻辑提升指定用户为
admin；若该用户不存在则打印警告但**不**回退到创建临时管理员（避免覆盖运维
人员的明确意图）。

#### Scenario: 全新部署自动创建引导管理员

- **WHEN** `deno task seed` 在全新数据库上执行，且不存在可登录 admin
- **THEN** 系统创建 username=`admin` 的临时管理员，`must_change_password=true`，
  并在终端打印临时凭证（含强制改密提醒）

#### Scenario: 已存在可登录 admin 时跳过

- **WHEN** `deno task seed` 执行时 users 表中已存在至少一个 `role='admin' AND id != '0'` 的用户
- **THEN** 系统跳过引导管理员创建，不打印临时凭证

#### Scenario: 已设置 ADMIN_EMAIL 时使用 env 账户

- **WHEN** 环境变量 `ADMIN_EMAIL=ops@example.com` 且对应用户已注册
- **THEN** 系统沿用既有 `ensureAdminFromEnv()` 逻辑提升该用户为 admin，不创
  建临时引导管理员

#### Scenario: ADMIN_EMAIL 对应用户不存在

- **WHEN** 环境变量 `ADMIN_EMAIL=missing@example.com` 且该用户未注册
- **THEN** 系统打印警告，但**不**自动创建引导管理员（保持运维人员的明确意
  图优先）

#### Scenario: 重复执行 seed 幂等

- **WHEN** 已存在 `must_change_password=true` 的临时 admin，再次执行
  `deno task seed`
- **THEN** 系统跳过引导管理员创建（按"已存在可登录 admin"分支）

### Requirement: 强制首次改密（管理员）

系统 SHALL 在 `must_change_password=true` 时拒绝该用户访问除白名单外的所有受
保护路径，强制其先修改密码。

#### Scenario: 未改密用户访问受保护端点

- **WHEN** `must_change_password=true` 的用户调用 `/api/v1/submissions` 等非
  白名单受保护端点
- **THEN** 系统返回 HTTP 403，错误消息 `"请先修改密码"`，`code` 为
  `PASSWORD_CHANGE_REQUIRED`

#### Scenario: 未改密用户访问白名单端点

- **WHEN** `must_change_password=true` 的用户调用
  `/api/v1/auth/change-password`、`/api/v1/auth/me` 或 `/api/v1/auth/logout`
- **THEN** 系统正常处理请求

#### Scenario: 改密成功后解除限制

- **WHEN** 用户成功调用 `POST /api/v1/auth/change-password`
- **THEN** 系统更新 `password_hash` 并设置 `must_change_password=false`，后续
  签发的 JWT 不再携带强制改密 claim

## ADDED Requirements

### Requirement: 引导管理员临时凭证打印

`ensureBootstrapAdmin()` 创建管理员后 MUST 在终端以醒目格式（带 `⚠` 图标）打
印 username、email、password 三个字段，便于首次部署者立即登录。打印格式：

```
⚠ 已创建临时引导管理员（首次登录后必须修改密码）：
  username: admin
  email:    admin@noj.local
  password: <24字符 base64url>
```

#### Scenario: 凭证打印格式

- **WHEN** `ensureBootstrapAdmin()` 成功插入临时管理员
- **THEN** 终端输出包含上述三行的提示块