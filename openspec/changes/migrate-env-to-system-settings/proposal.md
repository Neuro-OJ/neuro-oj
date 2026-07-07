## Why

当前 noj-core 仅有 5 个系统设置项可通过管理后台（`/admin/settings`）动态修改，其余 20+ 个配置项仍依赖 `.env` 文件和重启生效。每次调整邮件配置、速率限制参数或审计日志保留天数都需要 SSH 登录服务器 → 修改 `.env` → 重启进程，运维成本高且存在误操作风险。将大多数应用层配置迁移到 `system_settings` 表后可实现管理后台统一管理、即时生效，降低运维门槛。

## What Changes

- **扩展 DB-backed 设置注册表**：将约 15 个应用层配置项从 env-only 迁移为 DB-backed，纳入 `SETTING_DEFINITIONS` 注册表，使管理员可通过 `PUT /api/v1/admin/settings/:key` 即时修改
- **重构配置读取路径**：所有被迁移的配置项，代码中不再直接调用 `Deno.env.get()`，改为通过 `getSetting()` 读取（走 DB → env → default 兜底链）
- **env-only 白名单精简**：仅保留真正的基础设施配置项（数据库连接、Redis 连接、JWT 密钥、存储后端、启动端口等），这些配置项在 DB 可用之前就需要，无法 DB-backed
- **新增 integer 类型**：为速率限制等数值型配置新增 `integer` setting type，支持 `min`/`max` 范围校验
- **管理后台 UI 扩展**：前端设置页面新增 integer 类型输入控件（number input），更新可编辑区域展示
- **向后兼容**：所有被迁移的配置项保留 env fallback，现有 `.env` 文件中的值仍可作为启动期默认值，DB 中有值时优先使用 DB 值

## Capabilities

### New Capabilities
- `settings-integer-type`: 为系统设置注册表新增 `integer` 类型，支持 `min`/`max` 范围校验和 number input 控件

### Modified Capabilities
- `admin-system-settings`: 扩展 DB-backed 设置注册表（从 5 项增至约 20 项），重构所有被迁移配置项的读取路径为 `getSetting()` 调用；新增 `integer` 类型支持；env-only 白名单精简为仅基础设施配置项；管理后台 UI 适配新类型和新设置项

## Impact

- **noj-core `lib/settings-registry.ts`**：新增约 15 个 `SettingDefinition` 条目 + `integer` type 支持
- **noj-core `lib/env-snapshot.ts`**：移除已迁移至 DB-backed 的 env-only 定义（约 15 项移除，保留约 15 项基础设施配置）
- **noj-core `services/system-settings.ts`**：新增 `integer` 类型校验逻辑（min/max 约束）
- **noj-core `lib/jwt.ts`**：`JWT_EXPIRES_IN` 改为通过 `getSetting()` 读取
- **noj-core `lib/password.ts`**：`BCRYPT_SALT_ROUNDS` 改为通过 `getSetting()` 读取
- **noj-core `lib/email.ts` + `lib/email-providers/*.ts`**：邮件 Provider 及凭据改为通过 `getSetting()` 读取
- **noj-core `lib/rateLimitEnv.ts`**：速率限制参数改为通过 `getSetting()` 读取
- **noj-core `services/audit-log.ts`**：`AUDIT_LOG_RETENTION_DAYS` 改为通过 `getSetting()` 读取
- **noj-core `main.ts`**：调整启动顺序，确保 `initSystemSettings()` 在使用 DB-backed 设置的模块之前执行
- **noj-core `app.ts`**：CORS 配置改为通过 `getSetting()` 读取
- **noj-ui `pages/admin/settings.vue`**：新增 integer 类型输入控件，扩展可编辑设置项列表
