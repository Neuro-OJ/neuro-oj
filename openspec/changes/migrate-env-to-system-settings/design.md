## Context

当前 noj-core 的配置项分为两层：

1. **DB-backed（5 项）**：通过 `system_settings` 表 + `SETTING_DEFINITIONS` 注册表 → `getSetting()` 读取（DB → env → default），管理后台可即时修改
2. **env-only（25 项）**：通过 `ENV_ONLY_DEFINITIONS` 白名单 → 启动期 `snapshotEnv()` 快照 → `Deno.env.get()` 直接读取，修改需重启

基础设施（`system_settings` 表、迁移、服务层 `system-settings.ts`、管理 API、前端页面）已在 issue #99 中完整实现。本 change 的目标是将第 2 层中的**应用层配置项**迁移到第 1 层。

## Goals / Non-Goals

**Goals:**
- 将约 15 个应用层配置项从 env-only 迁移为 DB-backed，实现管理后台即时修改
- 新增 `integer` setting type，支持 `min`/`max` 范围校验
- 所有迁移后的配置项代码中改用 `getSetting()` 读取
- 始终保持向后兼容：env 值作为 fallback，现有 `.env` 不改也能正常运行
- 精简 env-only 白名单，仅保留基础设施配置项

**Non-Goals:**
- 不迁移 noj-judge（Rust）的配置项 — judge 无 DB 访问，且 env 配置已足够
- 不迁移 noj-ui 的配置项 — UI 仅有一个 `NUXT_PUBLIC_API_BASE_URL`，通过 Nitro 代理处理
- 不改变 system_settings 表结构（建表迁移 0012 已完成）
- 不引入热重载机制 — 写路径失效缓存后下次读取自动生效，无需信号通知

## Decisions

### Decision 1: 配置项分类标准

将所有 30 个 env 配置项按以下标准分为两类：

**基础设施（保留为 env-only）** — 在 DB 可用之前就需要，或涉及启动期行为：

| 配置项 | 保留原因 |
|--------|---------|
| `DATABASE_URL` | DB 连接本身，DB 不可用时无法读取 system_settings |
| `DATABASE_POOL_MAX` | DB 连接池调优，连接建立前需要 |
| `DATABASE_CONNECT_TIMEOUT` | 同上 |
| `DATABASE_IDLE_TIMEOUT` | 同上 |
| `DATABASE_MAX_LIFETIME` | 同上 |
| `REDIS_URL` | Redis 连接，与 DB 同级的基础设施 |
| `JWT_SECRET` | 安全密钥，应在部署环境隔离；签名和验证密钥应一致不可运行时随意变更 |
| `PORT` | HTTP 监听端口，启动时绑定 |
| `NOJ_ENV` | 环境模式，影响多处行为（日志、CORS、健康检查） |
| `STORAGE_PROVIDER` | 存储后端选择（local/s3），影响 `initStorage()` |
| `S3_ENDPOINT` | S3 基础设施配置 |
| `S3_REGION` | S3 基础设施配置 |
| `S3_ACCESS_KEY` | S3 基础设施凭证 |
| `S3_SECRET_KEY` | S3 基础设施凭证 |
| `S3_BUCKET` | S3 基础设施配置 |
| `S3_FORCE_PATH_STYLE` | S3 基础设施配置 |
| `ADMIN_EMAIL` | Seed 阶段使用，在 `initSystemSettings()` 之前 |
| `ADMIN_PASS` | Seed 阶段使用，在 `initSystemSettings()` 之前 |
| `BCRYPT_SALT_ROUNDS` | 在 `lib/password.ts` 模块加载时读取，修改会影响已有密码哈希的一致性 |

**应用层（迁移为 DB-backed）** — 请求时读取，修改后即时生效无需重启：

| 配置项 | setting key | type | default | category |
|--------|-------------|------|---------|----------|
| `JWT_EXPIRES_IN` | `jwt_expires_in` | string | `"24h"` | auth |
| `EMAIL_PROVIDER` | `email_provider` | string | `"mock"` | email |
| `SMTP_FROM` | `smtp_from` | string | `""` | email |
| `ALIBABA_ACCESS_KEY_ID` | `alibaba_access_key_id` | string | `""` | email |
| `ALIBABA_ACCESS_KEY_SECRET` | `alibaba_access_key_secret` | string | `""` | email |
| `ALIBABA_FROM_EMAIL` | `alibaba_from_email` | string | `""` | email |
| `TENCENT_SECRET_ID` | `tencent_secret_id` | string | `""` | email |
| `TENCENT_SECRET_KEY` | `tencent_secret_key` | string | `""` | email |
| `TENCENT_FROM_EMAIL` | `tencent_from_email` | string | `""` | email |
| `TENCENT_REGION` | `tencent_region` | string | `"ap-guangzhou"` | email |
| `RATE_LIMIT_ENABLED` | `rate_limit_enabled` | boolean | `true` | rate_limit |
| `RATE_LIMIT_LOGIN_IP_WINDOW` | `rate_limit_login_ip_window` | integer | `30` | rate_limit |
| `RATE_LIMIT_LOGIN_IP_MAX` | `rate_limit_login_ip_max` | integer | `10` | rate_limit |
| `RATE_LIMIT_LOGIN_ACC_WINDOW` | `rate_limit_login_acc_window` | integer | `30` | rate_limit |
| `RATE_LIMIT_LOGIN_ACC_MAX` | `rate_limit_login_acc_max` | integer | `5` | rate_limit |
| `RATE_LIMIT_LOGIN_BACKOFF_SEC` | `rate_limit_login_backoff_sec` | integer | `15` | rate_limit |
| `RATE_LIMIT_LOGIN_LOCK_THRESHOLD` | `rate_limit_login_lock_threshold` | integer | `10` | rate_limit |
| `RATE_LIMIT_LOGIN_LOCK_SECONDS` | `rate_limit_login_lock_seconds` | integer | `3600` | rate_limit |
| `TRUSTED_PROXIES` | `trusted_proxies` | string | `""` | rate_limit |
| `AUDIT_LOG_RETENTION_DAYS` | `audit_log_retention_days` | integer | `90` | other |
| `ALLOW_REGISTER` | `allow_register` | boolean | `true` | auth |
| `RATE_LIMIT_LOGIN_ENABLED` | `rate_limit_login_enabled` | boolean | `true` | rate_limit |
| `MAINTENANCE_MODE` | `maintenance_mode` | boolean | `false` | maintenance |
| `HOMEPAGE_BANNER` | `homepage_banner` | text | `""` | maintenance |

> 最后 4 项已存在，列出以展示完整注册表。

**备选方案考虑**：曾考虑将 `BCRYPT_SALT_ROUNDS` 也迁移，但由于它在 `lib/password.ts` 模块顶层读取（`const SALT_ROUNDS = parseInt(Deno.env.get(...))`），改为 `getSetting()` 后每次哈希都需查缓存。考虑到 bcrypt cost 几乎不需要运行时修改（修改会导致新旧密码哈希不一致），保留为 env-only 更合理。

### Decision 2: 新增 `integer` type

**选择**：在 `SettingType` 联合类型中新增 `"integer"`，`SettingDefinition` 增加可选的 `min`/`max` 字段。

```typescript
export type SettingType = "boolean" | "string" | "text" | "integer";

export interface SettingDefinition {
  key: string;
  type: SettingType;
  default: boolean | string | number;
  description: string;
  is_secret: boolean;
  envFallback: string;
  category: SettingCategory;
  min?: number;  // integer 类型专用
  max?: number;  // integer 类型专用
}
```

校验规则：
- 值必须为 `number` 类型（浮点数拒绝）
- `Number.isInteger(value)` 为 true
- 若 `min` 定义，值 ≥ min
- 若 `max` 定义，值 ≤ max

**备选方案**：用 `string` 类型存储数字，读取时 `parseInt`。这会导致类型系统不一致（`getSetting` 返回 string 但期望 number），且无法在前端用 number input。选择显式 integer 类型更清晰。

### Decision 3: 代码重构策略

对每个被迁移的配置项，将其读取路径从 `Deno.env.get("KEY")` 改为 `getSetting("key")`。

**模式 A — 简单替换（大部分配置项）**：

```typescript
// Before
const val = Deno.env.get("RATE_LIMIT_LOGIN_IP_MAX") || "10";

// After
const setting = getSetting("rate_limit_login_ip_max");
const val = String(setting?.value ?? 10);
```

**模式 B — 模块级常量（需改为函数调用）**：

`lib/rateLimitEnv.ts` 中的 `envInt()`/`envBool()` 辅助函数改为调用 `getSetting()`：

```typescript
// Before
export function envInt(name: string, defaultVal: number): number {
  const v = Deno.env.get(name);
  return v ? parseInt(v, 10) : defaultVal;
}

// After
export function settingInt(key: string): number {
  const s = getSetting(key);
  return typeof s?.value === "number" ? s.value : (findDefinition(key)?.default as number);
}
```

**模式 C — 启动期读取（需要特殊处理）**：

`EMAIL_PROVIDER` 在 `main.ts` 中用于启动期 Provider 校验，同时也在 `lib/email.ts` 中用于运行时发邮件。处理方式：

- `main.ts` 中的校验改为 `getSetting("email_provider")`，此时 `initSystemSettings()` 已完成
- `lib/email.ts` 中的运行时选择同样改为 `getSetting("email_provider")`

`CORS_ALLOWED_ORIGINS` 在 `app.ts` 中读取。`app.ts` 是模块级代码，import 时即执行。处理方式：

- 从 `app.ts` 模块顶层移除 CORS 配置读取
- 改为在 Hono 的中间件/路由中动态读取（或保持 env fallback，因为 CORS 变更极少需要运行时修改）
- **权衡**：考虑到 CORS 配置极少需要运行时修改，且改为动态读取会增加每次请求的开销，决定 `cors_allowed_origins` 保留 env fallback 方式但不将其作为主要 DB-backed 设置项推广

### Decision 4: 向后兼容策略

所有迁移的配置项保留 `envFallback` 字段，`getSetting()` 的兜底链不变：DB → env → default。

迁移路径：
1. 部署新版本 noj-core（含扩展后的注册表 + 代码重构）
2. 现有 `.env` 中的值自动成为 env fallback（`source: "env"`）
3. 管理员通过 UI 修改任意设置项 → DB 写入 → `source: "db"`，DB 值优先
4. 管理员"重置"设置项 → DB 行删除 → 回退到 env 值
5. 无需修改 `.env`、无需数据迁移

## Risks / Trade-offs

- **[风险] 管理员误操作将关键配置改为非法值** → 缓解：`validateValueType()` 严格校验 type + min/max 范围；操作写入审计日志可追溯
- **[风险] 邮件凭证通过管理后台可读（虽掩码但可重置）** → 缓解：邮件凭证标记 `is_secret: true`，UI 掩码展示；重置操作写审计日志
- **[风险] JWT_EXPIRES_IN 改为 DB-backed 后，若 DB 中误设为极短值可能导致所有用户立即登出** → 缓解：string 类型校验需匹配格式（如 `"24h"`、`"7d"`）；管理员操作前前端提示影响范围
- **[权衡] 速率限制参数运行时修改可能导致突发流量异常** → 缓解：`getSetting()` 每次请求读取内存缓存（O(1)），无性能影响；变更即时生效是特性而非 bug
- **[权衡] `CORS_ALLOWED_ORIGINS` 保持 env-only 而非 DB-backed** → 理由：CORS 在 `app.ts` 模块加载时读取，改为动态读取开销大于收益；且 CORS 白名单在部署时确定，极少运行时修改

## Migration Plan

1. **Phase 1 — 扩展注册表**：`settings-registry.ts` 新增约 15 个条目 + integer type，`validateRegistry()` 自动校验
2. **Phase 2 — 重构读取路径**：逐文件将 `Deno.env.get()` 替换为 `getSetting()`
3. **Phase 3 — 精简 env-only**：从 `env-snapshot.ts` 的 `ENV_ONLY_DEFINITIONS` 中移除已迁移项
4. **Phase 4 — 更新 validation**：`system-settings.ts` 的 `validateValueType()` 新增 integer 校验分支
5. **Phase 5 — 前端适配**：`pages/admin/settings.vue` 新增 integer 输入控件（number input + min/max 属性）
6. **Phase 6 — 测试**：更新单元测试 + E2E 测试，验证 DB-backed 设置项读写 + env fallback 兜底

**回滚策略**：所有代码改动在同一个 commit 中；回滚即 revert commit。DB 中可能已有新增设置项的行，但删除迁移后的代码不影响（这些行不会被读取，env 值继续生效）。

## Open Questions

- 是否需要在管理后台增加"批量导出/导入设置"功能以便跨环境迁移？（本 change 不做，后续评估）
- `EMAIL_PROVIDER` 的值变更后，是否需要运行时重新初始化邮件 Provider？（当前每次发送时动态选择 Provider，所以即时生效）
