## MODIFIED Requirements

### Requirement: 管理员更新设置

系统 SHALL 提供 `PUT /api/v1/admin/settings/:key`，body 为 `{ value: T }`，执行 UPSERT 写入 `system_settings` 表。

校验规则：
- `key` SHALL 必须在 `SETTING_DEFINITIONS` 注册表中，否则返回 400
- `value` SHALL 匹配注册表声明的 `type`，否则返回 400
  - `boolean` 类型：值必须为 `true` 或 `false`
  - `string` 类型：值必须为字符串；特定 key（如 `smtp_from`）有额外格式校验
  - `text` 类型：值必须为字符串，长度 ≤ 1000
  - `integer` 类型：值必须为整数（`Number.isInteger`），若定义 `min`/`max` 则必须在范围内
- `value` SHALL 通过应用层特定校验（如 `smtp_from` 必须是 email 格式或空字符串）
- `homepage_banner` 长度 SHALL ≤ 1000 字符

成功后 SHALL 失效内存缓存中对应 key 的条目，异步 reload。

操作 SHALL 写审计日志：`logAudit("settings.update", { action, key, from, to }, { type: "system_setting", id: key })`。

#### Scenario: 合法 boolean 更新

- **WHEN** admin 调用 `PUT /api/v1/admin/settings/maintenance_mode` body=`{value: true}`
- **THEN** DB 行 UPSERT 成功，响应 200 + `{ data: { ... } }`，第二次 `GET` 该项 `source='db'` `effective_value=true`

#### Scenario: 合法 integer 更新

- **WHEN** admin 调用 `PUT /api/v1/admin/settings/rate_limit_login_ip_max` body=`{value: 20}`
- **THEN** DB 行 UPSERT 成功，响应 200，`effective_value` 为数字 20

#### Scenario: 类型错返回 400

- **WHEN** admin 调用 `PUT /api/v1/admin/settings/allow_register` body=`{value: "yes"}`
- **THEN** 响应 400，body 含 `error: 'VALIDATION_ERROR'` + `message: 'allow_register 必须是 boolean（true/false）'`

#### Scenario: integer 浮点数被拒

- **WHEN** admin 调用 `PUT /api/v1/admin/settings/rate_limit_login_ip_max` body=`{value: 10.5}`
- **THEN** 响应 400，message: 'rate_limit_login_ip_max 必须是整数（integer）'

#### Scenario: integer 超出 min 范围被拒

- **WHEN** admin 调用 `PUT /api/v1/admin/settings/rate_limit_login_backoff_sec` body=`{value: 0}`
- **AND** 该设置项定义了 `min: 1`
- **THEN** 响应 400，message: 'rate_limit_login_backoff_sec 不能小于 1（当前 0）'

#### Scenario: integer 超出 max 范围被拒

- **WHEN** admin 调用 `PUT /api/v1/admin/settings/rate_limit_login_lock_seconds` body=`{value: 99999}`
- **AND** 该设置项定义了 `max: 86400`
- **THEN** 响应 400，message: 'rate_limit_login_lock_seconds 不能大于 86400（当前 99999）'

#### Scenario: 未注册 key 返回 400

- **WHEN** admin 调用 `PUT /api/v1/admin/settings/hacker_key` body=`{value: 1}`
- **THEN** 响应 400，message: '未注册的设置项: hacker_key'

#### Scenario: smtp_from 格式错返回 400

- **WHEN** admin 调用 `PUT /api/v1/admin/settings/smtp_from` body=`{value: "not-an-email"}`
- **THEN** 响应 400，message: 'smtp_from 必须是有效 email 格式或空字符串'

#### Scenario: homepage_banner 超长返回 400

- **WHEN** admin 调用 `PUT /api/v1/admin/settings/homepage_banner` body=`{value: "x".repeat(1001)}`
- **THEN** 响应 400，message: 'homepage_banner 长度不能超过 1000 字符'

#### Scenario: 审计日志写入

- **WHEN** admin 调用 `PUT` 成功后
- **THEN** noj-core 审计日志记录一条 `settings.update` 事件（含 key、from、to）

### Requirement: 前端管理页面

`noj-ui` SHALL 提供 `pages/admin/settings.vue` 页面，路径 `/admin/settings`，仅 admin 可见。

页面 SHALL 包含两个区域：

**区域一：可编辑设置表格（DB-backed 约 20 项）**

- 列：key / 类型 / 当前值（可编辑控件）/ 来源（DB/env/default 标签）/ 描述 / 操作（保存 + 重置按钮）
- boolean 类型渲染 Switch 组件
- string 类型渲染 Input
- text 类型渲染 textarea（max 1000 字符）
- integer 类型渲染 `<input type="number" step="1">`，设定 `min`/`max` 属性（若注册表定义）
- 用户编辑后行高亮（dirty 状态）
- "保存"按钮：`PUT /api/v1/admin/settings/:key`，成功后 toast 成功 + 重载数据
- "重置"按钮：弹 dialog 确认 → `DELETE /api/v1/admin/settings/:key` → 重载
- 可编辑项按 category 分组展示（auth / maintenance / email / rate_limit / storage / other），每组带标题

**区域二：只读折叠面板（env-only 设置项，仅基础设施配置）**

- 折叠标题："环境变量（只读，需重启生效）"
- 表格列：key / value（is_secret=true 掩码）/ 描述
- 顶部提示文字："修改这些项需要更新 .env 并重启 noj-core 服务"
- 按 category 分组（database / redis / auth / cors / other）

页面 SHALL 复用 `components/ui/AsyncContent.vue` 三态容器与 `components/admin/AdminTable.vue`。

#### Scenario: admin 访问页面

- **WHEN** admin 用户访问 `/admin/settings`
- **THEN** 页面渲染成功，约 20 个 DB-backed 项 + 约 15 个 env-only 项均加载

#### Scenario: 普通用户被重定向

- **WHEN** 非 admin 用户访问 `/admin/settings`
- **THEN** middleware/admin.ts 静默重定向到 `/`（首页）

#### Scenario: 切换 boolean 并保存

- **WHEN** admin 在 `allow_register` 行点击 Switch 切到 false → 点保存
- **THEN** `PUT /api/v1/admin/settings/allow_register` 调用 → toast.success → 行 source 变 `db` + effective_value=false

#### Scenario: 编辑 integer 并保存

- **WHEN** admin 在 `rate_limit_login_ip_max` 行输入 20 → 点保存
- **THEN** `PUT /api/v1/admin/settings/rate_limit_login_ip_max` 调用 → toast.success → 行 source 变 `db` + effective_value=20

#### Scenario: 重置弹确认

- **WHEN** admin 点击某行"重置"按钮
- **THEN** SweetAlert2 弹窗："确认将 XXX 重置为默认值？此操作不可撤销"
- **AND** 确认后 `DELETE` 调用 + toast.success + 行 source 变 `env`/`default`

#### Scenario: 敏感字段在 env-only 面板也掩码

- **WHEN** env-only 面板展示 `JWT_SECRET`
- **THEN** value 列显示掩码（保留前 3 后 3），不是明文

### Requirement: 初始注册表

系统 SHALL 在 `lib/settings-registry.ts` 中预定义约 20 个 DB-backed 设置项，按 category 分组：

**auth（2 项）：**

| key | type | default | description | is_secret | envFallback | min | max |
|-----|------|---------|-------------|-----------|-------------|-----|-----|
| `allow_register` | boolean | `true` | 是否开放新用户注册 | false | `ALLOW_REGISTER` | — | — |
| `jwt_expires_in` | string | `"24h"` | JWT Token 有效期 | false | `JWT_EXPIRES_IN` | — | — |

**maintenance（2 项）：**

| key | type | default | description | is_secret | envFallback |
|-----|------|---------|-------------|-----------|-------------|
| `maintenance_mode` | boolean | `false` | 维护模式（启用后写操作 API 返回 503） | false | `MAINTENANCE_MODE` |
| `homepage_banner` | text | `""` | 首页顶部公告（最多 1000 字符） | false | `HOMEPAGE_BANNER` |

**email（9 项）：**

| key | type | default | description | is_secret | envFallback |
|-----|------|---------|-------------|-----------|-------------|
| `email_provider` | string | `"mock"` | 邮件 Provider（mock/aliyun/tencent） | false | `EMAIL_PROVIDER` |
| `smtp_from` | string | `""` | 系统发件人地址 | false | `SMTP_FROM` |
| `alibaba_access_key_id` | string | `""` | 阿里云 DirectMail AccessKey ID | false | `ALIBABA_ACCESS_KEY_ID` |
| `alibaba_access_key_secret` | string | `""` | 阿里云 DirectMail AccessKey Secret | true | `ALIBABA_ACCESS_KEY_SECRET` |
| `alibaba_from_email` | string | `""` | 阿里云发信地址 | false | `ALIBABA_FROM_EMAIL` |
| `tencent_secret_id` | string | `""` | 腾讯云 SES SecretId | false | `TENCENT_SECRET_ID` |
| `tencent_secret_key` | string | `""` | 腾讯云 SES SecretKey | true | `TENCENT_SECRET_KEY` |
| `tencent_from_email` | string | `""` | 腾讯云发信地址 | false | `TENCENT_FROM_EMAIL` |
| `tencent_region` | string | `"ap-guangzhou"` | 腾讯云地域 | false | `TENCENT_REGION` |

**rate_limit（10 项）：**

| key | type | default | description | is_secret | envFallback | min | max |
|-----|------|---------|-------------|-----------|-------------|-----|-----|
| `rate_limit_login_enabled` | boolean | `true` | 是否启用登录速率限制 | false | `RATE_LIMIT_LOGIN_ENABLED` | — | — |
| `rate_limit_enabled` | boolean | `true` | 速率限制总开关 | false | `RATE_LIMIT_ENABLED` | — | — |
| `rate_limit_login_ip_window` | integer | `30` | IP 维度限流窗口（秒） | false | `RATE_LIMIT_LOGIN_IP_WINDOW` | 1 | 3600 |
| `rate_limit_login_ip_max` | integer | `10` | IP 维度窗口内最大尝试次数 | false | `RATE_LIMIT_LOGIN_IP_MAX` | 1 | 1000 |
| `rate_limit_login_acc_window` | integer | `30` | 账号维度限流窗口（秒） | false | `RATE_LIMIT_LOGIN_ACC_WINDOW` | 1 | 3600 |
| `rate_limit_login_acc_max` | integer | `5` | 账号维度窗口内最大尝试次数 | false | `RATE_LIMIT_LOGIN_ACC_MAX` | 1 | 100 |
| `rate_limit_login_backoff_sec` | integer | `15` | 每次失败退避秒数 | false | `RATE_LIMIT_LOGIN_BACKOFF_SEC` | 0 | 300 |
| `rate_limit_login_lock_threshold` | integer | `10` | 连续失败锁定阈值 | false | `RATE_LIMIT_LOGIN_LOCK_THRESHOLD` | 1 | 100 |
| `rate_limit_login_lock_seconds` | integer | `3600` | 锁定时长（秒） | false | `RATE_LIMIT_LOGIN_LOCK_SECONDS` | 60 | 86400 |
| `trusted_proxies` | string | `""` | 可信代理白名单（IP/CIDR，逗号分隔） | false | `TRUSTED_PROXIES` | — | — |

**storage（7 项）：**

| key | type | default | description | is_secret | envFallback |
|-----|------|---------|-------------|-----------|-------------|
| `storage_provider` | string | `"local"` | 存储 Provider（local/s3） | false | `STORAGE_PROVIDER` |
| `s3_endpoint` | string | `""` | S3 兼容存储端点 | false | `S3_ENDPOINT` |
| `s3_region` | string | `"us-east-1"` | S3 区域 | false | `S3_REGION` |
| `s3_access_key` | string | `""` | S3 访问密钥 | false | `S3_ACCESS_KEY` |
| `s3_secret_key` | string | `""` | S3 秘密密钥 | true | `S3_SECRET_KEY` |
| `s3_bucket` | string | `"noj-support-packages"` | S3 存储桶名 | false | `S3_BUCKET` |
| `s3_force_path_style` | boolean | `false` | 使用路径风格 URL（MinIO 等需要） | false | `S3_FORCE_PATH_STYLE` |

**other（1 项）：**

| key | type | default | description | is_secret | envFallback | min | max |
|-----|------|---------|-------------|-----------|-------------|-----|-----|
| `audit_log_retention_days` | integer | `90` | 审计日志保留天数（0 = 禁用清理） | false | `AUDIT_LOG_RETENTION_DAYS` | 0 | 365 |

启动时 SHALL 调用 `validateRegistry()`，检查：
- key 唯一
- type ∈ {boolean, string, text, integer}
- 若 type 为 integer 且定义了 min/max，则 min ≤ max

#### Scenario: 启动期注册表校验通过

- **WHEN** `validateRegistry()` 执行，所有 SETTING_DEFINITIONS 配置正确
- **THEN** 函数正常返回，启动继续

#### Scenario: 启动期注册表校验失败 — 重复 key

- **WHEN** `validateRegistry()` 检测到重复 key
- **THEN** 抛 Error 包含重复 key 信息，noj-core 启动失败退出

#### Scenario: 启动期注册表校验失败 — 非法 type

- **WHEN** `validateRegistry()` 检测到非法 type
- **THEN** 抛 Error 包含具体问题，noj-core 启动失败退出

#### Scenario: 启动期注册表校验失败 — integer min > max

- **WHEN** `validateRegistry()` 检测到 integer 类型设置项的 min > max
- **THEN** 抛 Error 包含具体问题，noj-core 启动失败退出
