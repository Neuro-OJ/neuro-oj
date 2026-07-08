## Context

`noj-core` 当前 13 张表，所有启动期配置通过 `Deno.env.get()` 散落在 `main.ts`、`app.ts`、`db/connection.ts`、`mq/connection.ts`、`lib/jwt.ts`、`lib/email.ts`、`lib/rateLimitEnv.ts`、`routes/health.ts` 等 8+ 个文件直接读取。管理后台有 6 个 CRUD 页面（users/problems/categories/submissions/judge-images/dashboard），模板成熟但**没有"系统设置"页面**。

### 现有约束

- 13 张表均在 `src/db/schema.ts` 中由 drizzle-orm `pgTable` 定义，最近 3 条迁移风格混合：
  - `0010_graceful_domino.sql`（drizzle-kit 生成，--> statement-breakpoint 标记）
  - `0008_judge_images.sql`（手写 `CREATE TABLE IF NOT EXISTS` + CHECK 约束）
  - `0007_submissions_rejudge_seq.sql`（手写 `ALTER TABLE ADD COLUMN`）
- 启动顺序在 `main.ts` 严格分层：JWT_SECRET 校验 → DB 迁移 → root 用户保证 → Redis 连接 → 消费者启动 → HTTP 服务
- `routes/admin.ts` line 30 有 `router.use("*", authMiddleware, adminMiddleware)`，新端点直接追加即可获得鉴权
- 服务层统一约定（见 `services/judge-images.ts` 样板）：纯 async 函数、`getDb()` 单例、AppError 体系、DTO 通过私有 `toResponse()` 映射
- 现有 `lib/logging.ts` 已用 `[judge] [email]` 等前缀做结构化日志；新审计日志沿用 `[admin]` 前缀（与 `console.log` 配合），issue #101 完整审计日志表是独立工作
- 前端 `layouts/admin.vue` 的 `navItems` 是硬编码数组，新增项需同时 `@lucide/vue` 导入图标
- 现有 settings 全部硬读 `Deno.env.get`，**没有运行时可变配置**——本次不切换现有读路径，只做"管理面板 + 持久化层"

### 调研结论

- **手写 SQL 迁移**：0011 选用手写 `CREATE TABLE IF NOT EXISTS` 风格（与 0008_judge_images 一致），更易读、不依赖 drizzle-kit 重生成快照
- **不使用 drizzle-orm JSONB 类型**：本仓现有代码未使用 jsonb 字段（验证：`grep jsonb noj-core/src/db/schema.ts` 0 匹配），用 `text` + 应用层 `JSON.parse/stringify` 减少新依赖
- **env 快照一次读**：在 `main.ts` 启动时遍历已注册 env-only 键名列表，一次性 `Deno.env.get` 到 Map，避免每次请求都读进程环境
- **审计日志简化**：先用 `console.log` + `[admin]` 前缀，issue #101 落库时再回填迁移（用 `actorId` + `key` 拼出结构化字段）

## Goals / Non-Goals

**Goals:**

- 管理后台可运行时改 5 个 DB-backed 设置项（allow_register / smtp_from / rate_limit_login_enabled / maintenance_mode / homepage_banner）
- 修改无需重启服务，下次请求生效（内存缓存失效 + DB 持久化）
- `.env` 中的现有 env-only 配置以只读折叠面板展示（敏感字段掩码）
- `.env` 中尚不存在的 DB-backed 设置项默认值自动 fallback
- 审计日志 `[admin] {actorId} {action} {key}` 写到 console（不建表）
- 服务启动时一次性快照 env-only 设置项（避免每请求 `Deno.env.get`）

**Non-Goals:**

- ❌ 实际切换现有代码 `Deno.env.get` → `getSetting`（留给后续 issue；本 PR 只建面板 + 持久化层）
- ❌ 完整的审计日志表（issue #101 独立工作）
- ❌ 设置项变更历史（diff/rollback）—— 审计日志只记"谁在什么时间改了什么 key 为何值"
- ❌ 用户级别的设置项覆盖（所有 admin 看到同一份）
- ❌ WebSocket / SSE 推送设置变更（前端刷新即生效）
- ❌ 设置项导入/导出（JSON/YAML）
- ❌ 设置项分组/标签 UI（issue #99 不要求）
- ❌ SMTP/邮件测试按钮
- ❌ 国际化（设置项描述默认中文，UI 文本中文）

## Decisions

### 1. 表结构：`system_settings` 单表 KV

**选择**：单表 KV 模式（key PK、value JSONB、description、is_secret、updated_at、updated_by FK），**不**用 EAV 三元模型。

**理由**：
- 5 个设置项都是单值，不需要 EAV 复杂度
- `value JSONB` 兼容 boolean/string/text 三种类型
- 强 schema 控制放在应用层 `settings-registry.ts`（启动期检查所有注册项的 type 与 DB value 匹配）

**SQL**：
```sql
CREATE TABLE IF NOT EXISTS system_settings (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,                     -- JSON-encoded，统一存文本避免类型漂移
  description  TEXT NOT NULL DEFAULT '',
  is_secret    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_system_settings_updated_at ON system_settings(updated_at DESC);
```

**`value` 用 TEXT 而非 JSONB 的理由**：本仓零 JSONB 经验、统一用 text 后应用层 `JSON.parse` 简单可控、且后续切换到 JSONB 只需改 schema + 一次迁移。

### 2. 服务层：内存缓存 + DB 兜底 + env 兜底

**选择**：单例 `Map<key, { value, updated_at, updated_by, source: 'db'|'env' }>`，启动时从 DB 全量加载，PUT/DELETE 时失效单条。

**API**：
```typescript
interface SettingValue {
  value: unknown;             // 解码后
  raw: string;                // JSON-encoded
  source: 'db' | 'env';
  updatedAt: string | null;
  updatedBy: string | null;
}

listSettings(): SettingValue[];                        // 含 DB + env-only 两类
getSetting(key): SettingValue | null;                  // 查不到返回 null
getAllEffectiveSettings(): Record<string, unknown>;    // 业务代码取所有值用
updateSetting(key, value, actorId): Promise<void>;
resetSetting(key): Promise<void>;                      // 从 DB 删除 → 回退 env
```

**缓存策略**：
- 启动时：`SELECT * FROM system_settings` 一次 → 写入 Map
- 读路径：先查 Map，miss 查 env（snapshot map），再 miss 返回 null
- 写路径：UPSERT/DELETE → 失效 Map 单条 → 异步 reload 单条
- 并发：单实例无锁（Node 单线程），多实例时各自缓存独立（DB 是真相源，TTL 30s 兜底防漂移）

**兜底链**：`DB value > env snapshot > registry default > null`

### 3. env 快照：启动期一次性读取

**选择**：新增 `lib/env-snapshot.ts`，在 `main.ts` 启动顺序中"MQ 消费者启动"前调用 `snapshotEnv()`，把当前 `Deno.env.toObject()` 完整快照到 module-level `Record<string, string | undefined>`，避免每次请求读 `Deno.env.get`。

**理由**：
- 当前 8+ 文件每次请求都 `Deno.env.get()`（hot path 上 0 性能问题但语义混乱）
- 快照后所有 env-only 设置项走 snapshot map，**逻辑与 DB 设置项同构**
- 启动期 + 热路径都是 O(1) 读

### 4. 注册表：启动期 schema 校验

**选择**：`lib/settings-registry.ts` 导出 5 个 DB-backed 设置项的元数据：
```typescript
{
  key: 'allow_register',
  type: 'boolean',
  default: true,
  description: '是否开放新用户注册',
  is_secret: false,
  envFallback: 'ALLOW_REGISTER',  // env 优先
}
```

启动时 `validateRegistry()` 检查：
- 5 个 key 唯一
- 所有 type ∈ {boolean, string, text}
- 所有 `envFallback` 在 .env.example 中有对应注释（仅警告，不阻断）

**env-only 注册表**：env-snapshot.ts 维护一个白名单，列出"应该在面板展示的 env 键"（按业务分组）。

### 5. 路由：4 个端点

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/v1/admin/settings` | 列出所有设置项（DB + env-only），含 metadata、effective value、source |
| GET | `/api/v1/admin/settings/:key` | 单个设置项详情 |
| PUT | `/api/v1/admin/settings/:key` | upsert（key 不存在 → insert；存在 → update） |
| DELETE | `/api/v1/admin/settings/:key` | 删除（reset to env/default） |

**鉴权**：组级 `authMiddleware + adminMiddleware` 自动覆盖（`routes/admin.ts:30` 已有）。

**审计**：每次 PUT/DELETE 写 `console.log("[admin] actor=${userId} action=${method} key=${key} value=${JSON.stringify(value)}")`。

**校验**：service 层用 zod-like 手工校验（与项目现有风格一致，零新依赖）：
- `allow_register` 必须 boolean
- `smtp_from` 必须是 email 格式或空字符串
- `rate_limit_login_enabled` 必须 boolean
- `maintenance_mode` 必须 boolean
- `homepage_banner` 必须是 text（长度 ≤ 1000）
- key 必须在注册表中（防任意 key 写入）

### 6. 前端：单页 + 侧栏入口

**路径**：`pages/admin/settings.vue`

**布局**：
- 顶部：标题"系统设置" + 描述"运行时可改的配置项，修改即时生效；只读配置需重启服务"
- 第一组（可编辑表格）：DB-backed 设置项 5 行（key / 类型 / 当前值 / 来源 / 描述 / 操作）
  - 当前值列：boolean 用 Switch 切换、string 用 Input、text 用 textarea（max 1000 字符）
  - 来源列：标签 `DB`（蓝）/ `env`（灰）/ `default`（灰）
  - 操作列：每行独立"保存"按钮（点保存前可改多个，未保存的 cell 高亮）
  - "重置"按钮：删除 DB 值，回退到 env/default（弹 dialog 确认）
- 第二组（只读折叠面板）：env-only 设置项（按业务分组：数据库/Redis/认证/限流/邮件/CORS）
  - 折叠面板标题："环境变量（只读，需重启生效）"
  - 表格列：key / value（敏感字段掩码为 `abc***xyz`）/ 描述
  - 顶部小提示文字："修改这些项需要更新 .env 并重启 noj-core 服务"
- 三态：复用 `AsyncContent`（loading / error / empty / data）

**侧栏**：`layouts/admin.vue` 的 `navItems` 数组追加 `{ label: '系统设置', to: '/admin/settings', icon: Settings }`，从 `@lucide/vue` 导入 `Settings` 图标，插在"评测镜像"与"提交管理"之间。

**复用样板**：`pages/admin/categories.vue`（编辑表单）+ `pages/admin/judge-images.vue`（带危险操作的 CRUD）+ `components/ui/AsyncContent.vue`（三态）。

### 7. 命名约定

- API 端点：`/api/v1/admin/settings` 与 `/api/v1/admin/settings/:key`（与 `/api/v1/admin/judge-images` 同款）
- 表名：`system_settings`（snake_case，与现有 13 张表一致）
- 文件名：`services/system-settings.ts`、`lib/settings-registry.ts`、`lib/env-snapshot.ts`（kebab-case 不用，因为文件名）
- 路由挂载点：追加到现有 `routes/admin.ts` 而非新建文件（admin 域集中）

## Risks / Trade-offs

- **[风险] value 用 TEXT+JSON.parse 而非 JSONB** → 缓解：应用层做严格 type 校验（注册表 + service 校验函数），写入失败抛 ValidationError；后续需要 JSONB 查询能力时一次性迁移升级
- **[风险] 多实例部署下缓存漂移** → 缓解：30s TTL 兜底（实现为 setInterval 定期 reload 所有 DB-backed keys）；MVP 单实例下用即时失效足够
- **[风险] 敏感 env 值明文返回** → 缓解：`is_secret` 标记 + 后端响应中按规则掩码（保留前 3 后 3 字符，中间 `***`），前端不显示明文
- **[取舍] 不切换现有代码读路径** → 有意识选择：本 PR 只做"管理面板 + 持久化层"，业务代码本期继续 `Deno.env.get`。切换工作分散到多个独立 issue（每个设置项单独切），最小爆破面
- **[风险] env-snapshot 在测试环境下行为不同** → 缓解：`lib/env-snapshot.ts` 的 `snapshotEnv()` 在 `NOJ_ENV === 'test'` 时跳过（测试环境 .env 可能不存在），返回空 Map 不阻断
- **[取舍] 审计日志只到 console** → 与项目当前约定一致（`[judge]` `[email]` 前缀），issue #101 落库时迁移不会丢失 console 历史（journald 可查）
- **[风险] homepage_banner 长文本撑布局** → 缓解：UI 用 textarea（多行）+ max 1000 字符校验；展示时折叠到 max-h-32 滚动
