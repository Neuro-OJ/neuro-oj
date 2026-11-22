# noj-core 配置分层语义治理设计（env × DB 统一注册表）

> 日期：2026-09-02
> 状态：Proposed（方向已获确认，待评审后进入实施计划）
> 范围：noj-core 配置体系 + noj-ui 管理后台设置页 + 文档/校验链路；不涉及 judge/gateway 运行时配置改造

## 1. 背景

noj-core 当前存在三套并存、职责不清的配置来源：

1. **DB-backed 设置（settings-registry，66 项）**：admin 后台可改，读取链为 `DB 值 → env 兜底 → 默认值`；
2. **env-only 白名单（env-snapshot，13 项）**：后台只读展示（DATABASE_URL、JWT_SECRET、PORT 等）；
3. **纯 infra/ops env（约 30 项）**：散落各文件的直接 `Deno.env.get`，后台完全不可见（TFA_ENCRYPTION_KEY、APP_URL、LOG_LEVEL、OAUTH_*、NOJ_LLM_* 等）。

核心痛点不是"存在 env 与 DB 两个存储"，而是**"谁说了算"的语义没有讲清**：

- 66 个 DB-backed 项里混着两种生命周期：真正可热改的（开关、阈值、社区策略）与启动期定型的（storage/email provider 单例、审计保留任务），注册表只对个别项标了 `needsRestart`，运营者无法预知改了要不要重启；
- env fallback 的"遮蔽"语义无人讲清：DB 有值就完全忽略 env，运维改了 `.env` 重启后依然不生效，除非先去后台点"重置"；
- 前端硬编码键白名单/分类，后端元数据多份手写副本（.env.example、check-env、CLAUDE.md、docs），注册表注释与实际数量已漂移（注释称 54 项、实际 66 项）。

## 2. 目标与非目标

### 2.1 目标

- 建立**生命周期两分法**语义：运行时可热改的归 DB（runtime）、启动期定型的归 env（bootstrap），每个配置项有唯一归属；
- 统一配置注册表：一套声明式元数据覆盖 DB-backed 项、原 env-only 项、纯 infra env 项，消灭多份手写副本；
- 后台配置页语义重写：分组/来源全部由 API 元数据驱动，删除前端硬编码；
- 文档/校验链路与注册表对齐，阻止漂移。

### 2.2 非目标

- 不自动生成 .env.example（保留手写注释，只做一致性校验）；
- 不改变 noj-judge / noj-llm-gateway / noj-ui 自身的 env 读取方式；
- 不改动 OAuth/LLM 等新登记项的现有读取路径（它们本来就只读 env）；
- 不做 UI 全新统一总览页（保持两段结构，语义重写）。

## 3. 概念模型：scope

每个配置项声明 `scope`：

- **runtime（DB-owned）**：运行时可热改。读取链 **DB > env 兜底（仅首次启动/开发环境） > default**。后台可改、可重置。
- **bootstrap（env-owned）**：启动期定型，变更需重启。读取链 **env > default**（**不读 DB**）。后台只读展示。

### 3.1 划归清单（DB-backed → bootstrap）

按功能组整组收归，共 17 项：

| 组 | 项 |
|---|---|
| storage（7） | storage_provider、s3_endpoint、s3_region、s3_access_key、s3_secret_key、s3_bucket、s3_force_path_style |
| email（9） | email_provider、smtp_from、alibaba_access_key_id、alibaba_access_key_secret、alibaba_from_email、tencent_secret_id、tencent_secret_key、tencent_from_email、tencent_region |
| other（1） | audit_log_retention_days |

> email 整组收归的理由：provider 选择与凭据属同一部署级事实，拆开会造成"provider 归 env、密钥归 DB"的割裂。
> 注意：email_provider 的 sendFn 缓存与 storage_provider 单例均为"首次访问定型"，描述中应写明"首次使用后需重启"。

其余 49 项保持 runtime（限流、社区、审核阈值、jwt_expires_in、allow_register、maintenance_mode 等）。

### 3.2 统一配置注册表

单一源 `config-registry`（在现有 `settings-registry.ts` 基础上扩展）取代 `SETTING_DEFINITIONS` + `ENV_ONLY_DEFINITIONS` 两套定义，声明每项：

- 通用：`key` / `type` / `default` / `description` / `is_secret` / `category` / `scope`
- runtime 专属：`envFallback`（env 键名，仅作兜底）、`min` / `max`
- bootstrap 专属：`envKey`（唯一事实源键名）

**env 键唯一性校验**：任一 env 键至多被一项声明（bootstrap `envKey` 或 runtime `envFallback`），启动期 `validateRegistry()` 校验，杜绝两个设置项抢同一 env 变量。

### 3.3 原 env-only 13 项与新登记 ~30 项

原 `ENV_ONLY_DEFINITIONS`（DATABASE_URL、JWT_SECRET、PORT、NOJ_ENV、REDIS_URL、CORS_ALLOWED_ORIGINS、ADMIN_*、BCRYPT_SALT_ROUNDS、DATABASE_* 池参数）并入注册表，scope: bootstrap（无 default）。

纯 infra env（TFA_ENCRYPTION_KEY、APP_URL、LOG_LEVEL、LOG_FORMAT、OAUTH_GITHUB_*、OAUTH_OIDC_*、NOJ_LLM_SERVICE_TOKEN、NOJ_LLM_GATEWAY_URL、NOJ_LLM_MAX_CALLS/TOKENS、RESULT_CONSUMER_CONCURRENCY、SUPPORT_PACKAGE_DIR、JUDGE_IMAGE_BASE、NOJ_ARTIFACT_MAX_SIZE_MB、NOJ_FORCE_PASSWORD_CHANGE、NOJ_ALLOW_INSECURE_HTTP 等）**全部登记入册**（scope: bootstrap，仅登记与展示，不改读取路径）。开发/测试专用键（NOJ_RUN_E2E、TEST_SCHEMA、NOJ_MIGRATIONS_DIR、NOJ_BYPASS_JWT_REVOKE 等）一并登记，可标记 `visible: false` 不在后台展示但参与校验。

## 4. 读取层语义

`getSetting(key)` 仍为统一入口，内部按 scope 分支：

- runtime：DB Map → env 快照兜底 → default；
- bootstrap：env 快照 → default（**不读 DB**，DB 残留旧值直接忽略）。

env 快照 `snapshotEnv()` 语义修正：只快照 bootstrap 项声明的 env 键（原 13 项 env-only + 划归 17 项 + 新登记项），不再承载 runtime 项的兜底读取（runtime 兜底走注册表 `envFallback` 的实时读取或启动快照，二选一并统一——倾向沿用现有"快照优先、实时兜底"）。

## 5. 存量切换与可观测性

"直接切换不迁移"落地为：bootstrap 项忽略 DB 旧值（读取不读 DB），同时提供清晰信号，避免运维困惑：

- **启动日志**：列出所有被忽略的残留 DB 行（key + 最后更新人/时间），提示"该配置已由 env 接管，DB 值不再生效"；
- **后台徽标**：该项显示来源 `env`，若 DB 存在残留行则附加"忽略 DB 旧值"提示，悬停可见旧值摘要；
- **一键清理**：对残留 DB 行提供"清理残留值"操作（DELETE 该 key 的 system_settings 行），幂等，审计记录 `settings.reset`。

## 6. 后台页改造（两段语义重写）

保留两段结构，语义重写，**分组/来源/描述全部由 API 元数据驱动，删除前端硬编码键白名单与分类表**：

- **上段「运行时可改」**：scope=runtime，行内编辑保存（现有交互保留）；
- **下段「环境配置（只读，重启生效）」**：scope=bootstrap，含原 13 项 env-only + 划归 17 项 + 新登记（visible 项），按 category 分组展示，来源统一为 env；
- 删除 `settings.vue` 中硬编码的 `ENV_ONLY_KEYS`、`SettingCategory`、`CATEGORY_LABEL`、分组顺序数组，改为 API 返回的注册表元数据驱动；
- 社区 preset 键表（`community.vue` 的 COMMUNITY_PRESETS / BOOLEAN_SETTINGS / NUMBER_SETTINGS）属同类重复，一并改为 API 元数据驱动（或本次范围仅 settings.vue——见 §8 待确认项）。

## 7. 一致性校验（文档链路）

`check-env` 增强（`deno task check:env` / `check:env:strict`）：

- 读取注册表，校验每个 bootstrap/env-owned 键**必须**出现在 `.env.example`；
- 反向校验 `.env.example` 中无孤儿键（已废弃但仍在模板中的键给出警告，strict 模式报错）；
- 校验注册表自身的 scope 声明完整性（bootstrap 必须有 envKey、runtime 必须有 envFallback 或明确无兜底）。

## 8. 待确认项

1. **community.vue preset 键表**是否纳入本次去重范围（与 settings.vue 同属元数据驱动改造），还是留待后续；
2. runtime 项 env 兜底的"快照 vs 实时"取舍细节。

## 9. 影响面与风险

| 项 | 影响 |
|---|---|
| 代码 | `settings-registry.ts`（扩展 scope/envKey）、`env-snapshot.ts`（按 scope 快照）、`system-settings.ts`（getSetting 分支 + listSettings 元数据）、`admin-settings.ts`（残留清理端点）、`main.ts`（启动日志） |
| UI | `settings.vue` 两段语义重写、元数据驱动；`community.vue`（若纳入） |
| 数据 | system_settings 表结构不变；存量 storage/email/audit 行变为忽略态（可清理） |
| 文档 | `.env.example` 分组注释更新（storage/email/audit 标为"启动期配置，后台只读"）、`dev-docs/engineering/config-layering.md`、noj-core/CLAUDE.md env 表 |
| 风险 | bootstrap 项若依赖 DB 值（如某环境只在 DB 配过 S3）切换后需在 env 补齐，否则回退默认——通过启动日志 + 后台徽标缓解；email 首次访问定型语义需在描述与文档中讲清 |

## 10. 验收标准

- 注册表单一源：`SETTING_DEFINITIONS` 与 `ENV_ONLY_DEFINITIONS` 合并为一，无重复 env 键声明；
- runtime 项后台可改即时生效（限流/社区/审核回归用例通过）；
- bootstrap 项后台只读、改 env 重启生效；DB 残留行被忽略并在启动日志 + 后台徽标提示；
- 设置页无前端硬编码键/分类/来源逻辑；
- `check:env` 能发现"新 env 键未进 .env.example"与"孤儿键"；
- 全部 66+13+~30 项在后台可见（visible 项除外），无配置盲区。
