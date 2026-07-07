## 1. 注册表扩展 + integer 类型

- [x] 1.1 `lib/settings-registry.ts`：`SettingType` 联合类型新增 `"integer"`，`SettingDefinition` 接口新增可选 `min`/`max` 字段，`VALID_TYPES` 数组新增 `"integer"`
- [x] 1.2 `lib/settings-registry.ts`：`SettingCategory` 联合类型新增 `"storage"`
- [x] 1.3 `lib/settings-registry.ts`：`SETTING_DEFINITIONS` 扩展至约 22 项（按 design.md Decision 1 表格），覆盖 auth、maintenance、email、rate_limit、storage、other 类别
- [x] 1.4 `lib/settings-registry.ts`：`validateRegistry()` 新增 integer 类型的 `min ≤ max` 校验

## 2. 服务层 integer 校验

- [x] 2.1 `services/system-settings.ts`：`validateValueType()` 新增 `case "integer"` 分支——校验 `Number.isInteger`、`min`/`max` 范围
- [x] 2.2 `services/system-settings.ts`：`updateSetting()` 中 integer 类型的审计日志，敏感字段掩码逻辑不适用于 integer（integer 不设为 secret）

## 3. 代码重构 — 替换 Deno.env.get() 为 getSetting()

- [x] 3.1 `lib/jwt.ts`：`JWT_EXPIRES_IN` 读取改为 `getSetting("jwt_expires_in")`，保留 env fallback
- [x] 3.2 `lib/rateLimitEnv.ts`：`envInt()` 改为 `settingInt()`，`envBool()` 改为 `settingBool()`，内部调用 `getSetting()`；`isRateLimitEnabled()` 改为读 `getSetting("rate_limit_enabled")`；`getTrustedProxies()` 改为读 `getSetting("trusted_proxies")`
- [x] 3.3 `lib/email.ts`：`EMAIL_PROVIDER` 选择改为 `getSetting("email_provider")`
- [x] 3.4 `lib/email-providers/aliyun.ts`：凭证读取改为 `getSetting("alibaba_access_key_id")` 等
- [x] 3.5 `lib/email-providers/tencent.ts`：凭证读取改为 `getSetting("tencent_secret_id")` 等
- [x] 3.6 `services/audit-log.ts`：`AUDIT_LOG_RETENTION_DAYS` 改为 `getSetting("audit_log_retention_days")`
- [x] 3.7 `main.ts`：移除 `EMAIL_PROVIDER` 的直接 `Deno.env.get` 调用，改为 `getSetting("email_provider")`（需确认 `initSystemSettings()` 已在此之前执行）
- [x] 3.8 `lib/storage/factory.ts`：`STORAGE_PROVIDER` 和 S3 配置（endpoint、region、凭证、bucket、force_path_style）改为通过 `getSetting()` 读取，移除 `Deno.env.toObject()` 调用
- [x] 3.9 全局搜索确保所有被迁移的 env key 不再通过 `Deno.env.get()` 直接读取（保留 infrastructure 项）

## 4. env-only 白名单精简

- [x] 4.1 `lib/env-snapshot.ts`：从 `ENV_ONLY_DEFINITIONS` 中移除已迁移至 DB-backed 的条目，仅保留 infrastructure 项（DATABASE_*、REDIS_URL、JWT_SECRET、PORT、NOJ_ENV、ADMIN_EMAIL、ADMIN_PASS、BCRYPT_SALT_ROUNDS）

## 5. 前端适配

- [x] 5.1 `noj-ui/pages/admin/settings.vue`：新增 integer 类型输入控件（`<input type="number" step="1">`）
- [x] 5.2 `noj-ui/pages/admin/settings.vue`：可编辑设置表格使用 `ENV_ONLY_KEYS` 白名单区分 DB-backed / env-only 项，env-only 分组保留只读展示
- [x] 5.3 `noj-ui/pages/admin/settings.vue`：确保敏感字段（`is_secret: true`）在编辑模式下也掩码展示，仅在点击编辑时显示明文输入框

## 6. 测试

- [x] 6.1 `tests/services/system-settings.test.ts`：新增 integer 类型的 5 个测试（合法值、浮点数拒绝、非数字拒绝、min 边界、max 边界）
- [x] 6.2 `tests/services/system-settings.test.ts`：更新 listSettings 测试验证新增注册表条目存在 + integer default 回退测试
- [x] 6.3 `tests/services/system-settings.test.ts`：新增 `validateRegistry()` 不抛错（当前注册表完整）
- [x] 6.4 更新 email-providers.test.ts 错误消息匹配（env var 名→中文 label）
- [x] 6.5 运行 `deno task test`（noj-core）**458 passed, 0 failed, 65 ignored**
- [x] 6.6 运行 `cargo test --lib`（noj-judge）**51 passed, 0 failed**
