## 1. 后端：DB 迁移

- [ ] 1.1 新建 `noj-core/drizzle/0011_system_settings.sql`，手写 `CREATE TABLE IF NOT EXISTS system_settings` + 单条 `CREATE INDEX`
- [ ] 1.2 追加 `drizzle/meta/_journal.json` 条目：`{"idx": 11, "version": "7", "when": 1762128000000, "tag": "0011_system_settings", "breakpoints": true}`
- [ ] 1.3 修改 `noj-core/src/db/schema.ts`，追加 `export const systemSettings = pgTable("system_settings", {...})` 导出（drizzle 表对象供应用层使用）

## 2. 后端：lib 层（registry + env-snapshot）

- [ ] 2.1 新建 `noj-core/src/lib/settings-registry.ts`，定义 5 个 DB-backed 设置项的 `SETTING_DEFINITIONS` 数组（key、type、default、description、is_secret、envFallback）
- [ ] 2.2 同文件导出 `validateRegistry()`：启动期检查 key 唯一 + type ∈ {boolean, string, text}
- [ ] 2.3 新建 `noj-core/src/lib/env-snapshot.ts`，导出 `envSnapshot: Record<string, string | undefined>` module-level 对象 + `snapshotEnv()` 函数（一次性遍历注册表中 env-only 键名列表）
- [ ] 2.4 同文件导出 `ENV_ONLY_KEYS` 数组（分组：DB/Redis/Auth/RateLimit/Email/CORS/Other），key 与 .env.example 注释对齐
- [ ] 2.5 `snapshotEnv()` 在 `NOJ_ENV === 'test'` 时返回空 Map 不阻断

## 3. 后端：service 层

- [ ] 3.1 新建 `noj-core/src/services/system-settings.ts`，导出 `initSystemSettings()`（启动期全量加载到 Map）+ `getSetting(key)` + `listSettings()` + `updateSetting(key, value, actorId)` + `resetSetting(key)`
- [ ] 3.2 `updateSetting` 实现：先查注册表（key 必须在 SETTING_DEFINITIONS 中，否则抛 `ValidationError`）→ 严格 type 校验（boolean/string/text + smtp_from email 格式）→ Drizzle UPSERT → 失效 Map 单条 → 异步 reload
- [ ] 3.3 `resetSetting` 实现：DELETE FROM system_settings WHERE key=? → 失效 Map → 异步 reload（reload 后从 env 取值）
- [ ] 3.4 `listSettings()` 返回合并数组：DB-backed 5 项 + env-only 全部；每项含 `effective_value`、`source`（db/env/default）、`is_secret`、`description`
- [ ] 3.5 敏感字段掩码：`is_secret=true` 的 `effective_value` 改为 `abc***xyz` 格式（保留前 3 后 3，中间省略）

## 4. 后端：路由层

- [ ] 4.1 修改 `noj-core/src/routes/admin.ts`，追加 4 个端点：`GET /settings` / `GET /settings/:key` / `PUT /settings/:key` / `DELETE /settings/:key`
- [ ] 4.2 所有端点继承组级 `authMiddleware + adminMiddleware`，无需重复声明
- [ ] 4.3 `GET /settings` 调 `listSettings()`，响应 `{ data: SystemSetting[] }`
- [ ] 4.4 `GET /settings/:key` 调 `getSetting(key)`，404 抛 `NotFoundError`
- [ ] 4.5 `PUT /settings/:key` 调 `updateSetting(key, body.value, c.get("userId"))`，body 用 `parseJsonBody` 解析；写完后 `console.log("[admin] actor=${userId} action=PUT key=${key} value=${JSON.stringify(body.value)}")`
- [ ] 4.6 `DELETE /settings/:key` 调 `resetSetting(key)`，204 No Content；同样打 console 审计日志

## 5. 后端：启动顺序集成

- [ ] 5.1 修改 `noj-core/src/main.ts`，在"DB 迁移"之后、"MQ 消费者启动"之前追加：
  - `await initSystemSettings()`（加载 DB 缓存）
  - `snapshotEnv()`（快照 env-only）
- [ ] 5.2 任一步失败：致命错误，启动失败退出
- [ ] 5.3 `validateRegistry()` 失败：致命错误，启动失败退出（开发期就发现问题）

## 6. 前端：设置页面

- [ ] 6.1 新建 `noj-ui/pages/admin/settings.vue`
- [ ] 6.2 `definePageMeta({ layout: 'admin', middleware: 'admin', ssr: false })`
- [ ] 6.3 数据：两个 ref —— `dbSettings = ref<DbSetting[]>([])`、`envSettings = ref<EnvSetting[]>([])`，加载函数 `loadSettings()` 并行 `$fetch` 两个端点
- [ ] 6.4 DB 设置表格：复用 `AdminTable` + 自定义 `#cell-value` slot（boolean 渲染 Switch、string 渲染 Input、text 渲染 textarea）
- [ ] 6.5 草稿状态：本地 `drafts = ref<Record<string, unknown>>({})`，切换 dirty 状态高亮该行
- [ ] 6.6 每行"保存"按钮：`await $fetch('/api/v1/admin/settings/' + key, { method: 'PUT', body: { value: drafts[key] } })`，成功后 `loadSettings()` 重载
- [ ] 6.7 每行"重置"按钮：`await useDialog().dialog.confirm('确认将 XXX 重置为默认值？')` → `await $fetch(... { method: 'DELETE' })` → 重载
- [ ] 6.8 env-only 折叠面板：用原生 `<details>` 或 `<Transition>` 控制展开，表格列 key / value（掩码） / 描述
- [ ] 6.9 顶部"修改即时生效，env-only 项需重启"提示横幅（`bg-blue-50 text-blue-700`）
- [ ] 6.10 错误处理：`try/catch` 捕获 → `toast.error(err.message)`；保存按钮 loading 态

## 7. 前端：侧栏入口

- [ ] 7.1 修改 `noj-ui/layouts/admin.vue`，从 `@lucide/vue` 导入 `Settings` 图标
- [ ] 7.2 在 `navItems` 数组的"评测镜像"与"提交管理"之间插入 `{ label: '系统设置', to: '/admin/settings', icon: Settings }`
- [ ] 7.3 验证：访问 `/admin/settings` 链接高亮，权限校验（middleware 自动）

## 8. 测试

- [ ] 8.1 新建 `noj-core/tests/services/system-settings_test.ts`：
  - [ ] 8.1.1 `initSystemSettings` 从 DB 全量加载到 Map（mock 3 行 → Map size=3）
  - [ ] 8.1.2 `getSetting` 命中 DB → source='db'；DB miss + env hit → source='env'；都 miss → source='default'
  - [ ] 8.1.3 `updateSetting` 严格 type 校验：allow_register='not-boolean' 抛 ValidationError
  - [ ] 8.1.4 `updateSetting` smtp_from='not-email' 抛 ValidationError
  - [ ] 8.1.5 `updateSetting` 未注册 key 抛 ValidationError
  - [ ] 8.1.6 `resetSetting` 删除 DB 行 → 下次 `getSetting` 走 env 兜底
  - [ ] 8.1.7 敏感字段掩码：`is_secret=true` 值的 effective_value 改为 `abc***xyz`
- [ ] 8.2 新建 `noj-core/tests/routes/admin_settings_test.ts`：
  - [ ] 8.2.1 `GET /api/v1/admin/settings` 无 token → 401
  - [ ] 8.2.2 `GET /api/v1/admin/settings` 普通用户 token → 403
  - [ ] 8.2.3 `GET /api/v1/admin/settings` admin token → 200 + `{ data: [...] }`
  - [ ] 8.2.4 `PUT /api/v1/admin/settings/allow_register` admin body={value: false} → 200 + DB row 更新
  - [ ] 8.2.5 `PUT` 未注册 key → 400 ValidationError
  - [ ] 8.2.6 `PUT` 类型错 → 400
  - [ ] 8.2.7 `DELETE /api/v1/admin/settings/allow_register` admin → 204 + DB row 删除

## 9. .env.example 与文档

- [ ] 9.1 修改 `noj-core/.env.example`，在末尾追加 5 个新 DB-backed 设置项的注释（说明这些项可在管理后台改，env 值仅作启动期 fallback）
- [ ] 9.2 注释格式：`# ALLOW_REGISTER=true  # 启动期默认值；运行时可在「管理后台 > 系统设置」修改`
- [ ] 9.3 修改 `AGENTS.md` 第 7 节"安全模型"，在"已知限制"区追加 1 条：当前 system_settings 写操作仅 console 审计，issue #101 落库后此限制解除

## 10. 验证

- [ ] 10.1 `cd noj-core && deno task test` 全部通过（含新 system-settings + admin_settings 测试）
- [ ] 10.2 `deno task fmt --check` 无格式问题
- [ ] 10.3 `deno task lint` 无 lint 错误
- [ ] 10.4 `cd noj-ui && npm run build` 成功（CI ui-check 通过）
- [ ] 10.5 启动 `noj-core`，访问 `GET /api/v1/admin/settings`（admin token）→ 返回 5 项 DB + N 项 env-only
- [ ] 10.6 `PUT /api/v1/admin/settings/maintenance_mode` body={value:true} → DB 写入 → 第二次 GET 该项 source='db'
- [ ] 10.7 启动 `noj-ui`，登录 admin → 侧栏出现"系统设置" → 页面表格渲染正确 → 切换 allow_register Switch 保存 → toast 成功
- [ ] 10.8 env-only 面板展开后，所有 env 键列出，敏感字段（JWT_SECRET/ALIBABA_ACCESS_KEY_SECRET）掩码正确
- [ ] 10.9 重置按钮：弹 dialog 确认 → DELETE 调用 → DB 行删除 → 行 source 变为 env/default
- [ ] 10.10 在 `noj-core` 启动日志中验证 `console.log("[admin] actor=... action=PUT key=...")` 出现
