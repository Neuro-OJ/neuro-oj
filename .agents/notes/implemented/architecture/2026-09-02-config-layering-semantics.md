# Agent Note: 配置分层语义治理——scope 两分法统一注册表

Status: implemented
日期: 2026-09-02

## Problem

noj-core 存在三套并存、职责不清的配置来源：DB-backed 设置（66 项，admin 可改，
读取链 DB→env→default）、env-only 白名单（13 项，后台只读展示）、纯 infra/ops env
（约 30 项直接 `Deno.env.get`，后台完全不可见）。核心痛点：

- 66 个 DB-backed 项混着两种生命周期（可热改 vs 启动期定型），注册表只对个别项标
  `needsRestart`，运营者无法预知改了什么要重启；
- env fallback 的"遮蔽"语义无人讲清：DB 有值就完全忽略 env，运维改了 `.env` 重启
  后仍不生效，除非先去后台点"重置"；
- 前端硬编码键白名单/分类，后端元数据多份手写副本（.env.example、check-env、
  CLAUDE.md、docs），注册表注释与实际数量漂移。

## Decision

建立**生命周期两分法（scope）**语义，每个配置项有唯一归属：

- **runtime（DB-owned）**：运行时可热改，读取链 `DB → env(仅兜底) → default`，
  后台可改可重置；
- **bootstrap（env-owned）**：启动期定型，读取链 `env → default`（不读 DB），
  后台只读。

落地方式：

1. `settings-registry.ts` 合并 `SETTING_DEFINITIONS` + `ENV_ONLY_DEFINITIONS` 为
   单一 `CONFIG_DEFINITIONS` 注册表，每项声明 `scope` + `envKey`（bootstrap）/
   `envFallback`（runtime）；原 13 项 env-only 与 ~40 项 infra env（TFA/OAuth/LLM/
   日志/评测等，开发测试键 `visible:false`）全部登记入册；
2. storage(7) + email(9) + audit_log_retention_days(1) = 17 项按功能组整组划归
   bootstrap（provider 单例/邮件 sendFn 缓存/保留任务均启动期定型）；
3. `getSetting` 按 scope 分支：bootstrap 跳过 DB Map 直接读 env 快照；
   `initSystemSettings` 不缓存 bootstrap 键；`updateSetting` 拒绝写 bootstrap 键；
4. **存量不迁移**：bootstrap 项忽略 DB 残留旧值，启动日志提示 + 后台
   `db_orphaned` 徽标 + DELETE 一键清理（`cleanupBootstrapRow`）；
5. `listSettings` 返回全部可见项（bootstrap 未配置也返回，显示"未配置"），带
   scope/visible/db_orphaned 元数据；`validateRegistry` 校验 scope 完整性与 env 键
   唯一性；
6. `settings.vue` 按 scope 两段渲染，删除硬编码 `ENV_ONLY_KEYS` 白名单与分类表；
7. `check-env` 新增 `inspectConsistency`：可见 bootstrap 键必须出现在 .env.example
   （注释示例也算声明），孤儿键警告（编排级白名单豁免）；
8. 补齐 `.env.example` 缺失键（DATABASE_POOL_*、BCRYPT_SALT_ROUNDS、
   CORS_ALLOWED_ORIGINS、NOJ_ENV、搜索限流 4 键等）。

## Alternatives considered

- **保留现状 + 强化语义表达**：不改数据归属，仅把规则讲透。缺点：storage/email
  等启动定型项仍可被后台误写，DB 残留造成"改了不生效"的坑仍在。
- **按单键生命周期收归（只收启动定型单键，凭据留 DB）**：会造成"provider 归 env、
  密钥归 DB"的功能组割裂，故按功能组整组收归。
- **存量自动清理迁移**：有静默丢配置风险，改为忽略 + 提示 + 一键清理。
- **自动生成 .env.example**：丢失手写精细注释，仅做一致性校验。

## Consequences

- 配置语义清晰：后台两段 = 运行时配置（即时生效）/ 环境配置（改 env 重启）；
- 前端不再硬编码后端元数据，注册表是唯一真源，check-env 阻止模板漂移；
- 17 项划归后，若某环境只在 DB 配过 S3/邮件，切换后需在 env 补齐否则回退默认——
  通过启动日志 + 后台徽标缓解；
- `email_provider` 的 sendFn 缓存与 `storage_provider` 单例是"首次访问定型"而非
  严格启动定型，文档已注明首次使用后需重启；
- 风险：bootstrap 项读取依赖 `snapshotEnv()` 先于使用方初始化（main.ts 顺序已保证）；
  测试环境（PGlite）快照为空时 bootstrap 项回退默认，语义正确。
