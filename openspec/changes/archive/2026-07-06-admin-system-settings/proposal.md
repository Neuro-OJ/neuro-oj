## Why

系统配置（注册开关、维护模式、限流开关、首页公告、邮件 FROM 地址等）目前全部通过 `noj-core/.env` 文件管理——修改需要重启服务，运维成本高且无法追溯历史变更。issue #99 要求把这些"运行时可变"的配置抽到数据库，通过管理后台运行时热更新，`.env` 仅作为启动期兜底默认值。

问题陈述（具体场景）：
- 临时关闭注册：现在需 SSH 登录服务器 → 改 `.env` → `docker compose restart noj-core`，期间服务不可用
- 紧急维护模式：无现成开关，临时方案是改 nginx 或前端
- 切换首页公告：直接编辑前端代码 → rebuild → 重新部署
- 谁改了配置：审计日志缺失（issue #101 待办），临时只能翻 `journalctl`

目标：把这 5 项高频运维配置做成"管理后台运行时可改"，`.env` 只读展示其他不常改的运行时配置。

## What Changes

- **新增**：Drizzle 迁移 `0011_system_settings.sql`，建 `system_settings` KV 表（key PK、value JSONB、description、is_secret、updated_at、updated_by FK）
- **新增**：`noj-core/src/services/system-settings.ts`，提供 `getAllSettings()` / `getSetting(key)` / `updateSetting(key, value, actorId)` / `resetSetting(key)`，含内存缓存（PUT/DELETE 时失效）
- **新增**：`noj-core/src/routes/admin.ts` 追加 `GET /api/v1/admin/settings` / `GET /api/v1/admin/settings/:key` / `PUT /api/v1/admin/settings/:key` / `DELETE /api/v1/admin/settings/:key`（继承 group 级 `authMiddleware + adminMiddleware`）
- **新增**：环境变量注册表 `noj-core/src/lib/settings-registry.ts`，定义 5 个 DB-backed 设置项的 schema（key、type、default、description、is_secret、envFallback）
- **新增**：`noj-core/src/lib/env-snapshot.ts`，启动期一次性快照所有 `Deno.env.get()` 读取为只读 env-only 设置项（NOJ_ENV/JWT_SECRET/REDIS_URL/PORT/DATABASE_*/RATE_LIMIT_*/EMAIL_*/ALIBABA_*/TENCENT_*/CORS_*/TRUSTED_PROXIES）
- **新增**：前端 `pages/admin/settings.vue`，表格列出 DB-backed 设置项（可编辑）+ 只读折叠面板展示 env-only 配置
- **修改**：`noj-ui/layouts/admin.vue`，navItems 追加 `{ label: '系统设置', to: '/admin/settings', icon: Settings }`（从 `@lucide/vue` 导入 `Settings`）
- **修改**：`noj-core/src/main.ts` 启动顺序追加"快照 env"步骤（在数据库迁移之后、HTTP 服务之前）
- **修改**：`noj-core/.env.example` 末尾追加 5 个新 DB-backed 设置项的注释说明

## Capabilities

### New Capabilities

- `admin-system-settings`: 管理员运行时配置管理——DB-backed 设置的增删改查、env 兜底、内存缓存、管理后台页面

### Modified Capabilities

- 无（不影响其它 spec）

## Impact

- **数据库**：新增 1 张表 `system_settings`（13 → 14 张），单条迁移 0011
- **noj-core**：新增 3 文件（services/system-settings.ts、lib/settings-registry.ts、lib/env-snapshot.ts）+ 修改 2 文件（routes/admin.ts 追加端点、main.ts 追加启动步骤）+ 1 条迁移
- **noj-ui**：新增 1 文件（pages/admin/settings.vue）+ 修改 1 文件（layouts/admin.vue 侧栏）
- **运行时**：5 个 DB-backed 设置项的代码读取点从 `Deno.env.get(KEY)` 切换为 `getSetting(KEY)`（issue #99 范围内**不实际切换**，先把面板做出来；后续 issue 按需切换，最小爆破面）
- **性能**：DB 查询 1 次/启动期（构建 settings 缓存），PUT/DELETE 失效缓存；正常请求路径只走内存 Map，O(1) 查找
- **安全**：env-only 设置中敏感字段（JWT_SECRET、ALIBABA_ACCESS_KEY_SECRET、TENCENT_SECRET_KEY、DATABASE_URL）前端只显示 key + 掩码（`abc***xyz`），不显示明文；is_secret=true 的 DB 设置同理处理；所有写操作打 `[admin]` 前缀审计日志
- **不向后兼容影响**：无（绿地实现；现有代码仍走 `Deno.env.get`，新代码走 `getSetting` 但本期不接入）
