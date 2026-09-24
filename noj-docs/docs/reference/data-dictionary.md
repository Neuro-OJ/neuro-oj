# 数据库与 Redis 数据字典

本页整理 Neuro OJ 在 **PostgreSQL** 中的各表、字段，以及 **Redis** 中各键族的具体作用，供运营者排查、审计与数据维护时参考。

::: danger 免责声明：本文档不保证完全准确

本文档由开发资料整理而成，**不保证与当前部署的代码、Schema 完全一致**，且会随开发迭代而变动，**恕不另行通知**。

- 本文档是**尽力而为（best-effort）的运维参考**，不是契约、不是自动化校验产物，也不随版本发布同步保证。
- 实际字段、约束、默认值**一律以线上数据库的 `\d+ <表名>` 与源码 `noj-core/src/shared/db/schema/`、`noj-llm-gateway/src/db/schema.ts` 为准**。
- **执行任何 `UPDATE` / `DELETE` / `ALTER` / `DROP` / `TRUNCATE` 或 Redis 的 `DEL` / `FLUSHDB` 等操作前，必须二次复核验证**，并先完成备份。

:::

## 如何使用本页

- **字段表读法**：`列` 为数据库中的真实列名；`类型` 为 PostgreSQL 类型；`约束 / 默认` 汇总主键（PK）、唯一（UK）、外键（FK）、`CHECK`、`NOT NULL` 与默认值；`说明` 给出业务语义。
- **风险标记**：
  - <span class="noj-danger-col">红色列名</span> 表示**敏感/危险列**（凭据、密钥、密文、用户内容、风控数据），读取或导出前需脱敏。
  - <span class="noj-danger-zone">DANGER ZONE</span> 徽标表示该表整体属于高风险区，误操作可能造成凭据泄露、账号接管或不可逆数据损坏。
- **时间字段约定**：本项目的所有时间戳以 **ISO 8601 文本**存储（如 `2026-09-24T12:00:00.000Z`），而非原生 `timestamptz`。竞赛时间字段受 `CHECK` 约束强制为「UTC + 毫秒 + `Z`」形态。
- **分数约定**：`score` 为 **×100 的整数**（例如 85.5 分存为 `8550`），应用层通过 `scoreToDb` / `scoreFromDb` 转换，避免浮点误差。
- **多数据库连接**：`noj-core`、`noj-llm-gateway`（以及 `noj-judge` 的运维脚本）共用**同一个 PostgreSQL 库**。LLM 三张表物理上在同库，但**逻辑所有权归 noj-llm-gateway**（迁移由 `noj-llm-gateway/drizzle/` 管理），详情见下文「LLM 网关表（noj-llm-gateway）」。

---

## DANGER ZONE 一览

以下对象属于**一碰就要格外小心**的高风险区。完整字段见后文对应小节，这里先给出清单与后果。

| 对象 | 风险点 | 误操作后果 |
| --- | --- | --- |
| `llm_providers` | <span class="noj-danger-col">`encrypted_api_key`</span> 为上游 LLM 服务的 API Key（AES-256-GCM 信封加密） | 泄露即上游账单被盗刷；误删导致所有 LLM 题评测失败 |
| `users` | <span class="noj-danger-col">`password_hash`</span>、<span class="noj-danger-col">`tfa_secret_encrypted`</span>、<span class="noj-danger-col">`email_verify_token`</span> | 泄露可离线爆破 / 绕过二次验证；误改 `session_version` 会强制全员下线 |
| `password_reset_tokens` | <span class="noj-danger-col">`token_hash`</span>（密码重置令牌哈希） | 泄露可接管账号 |
| `tfa_recovery_codes` | <span class="noj-danger-col">`code_hash`</span>（TFA 恢复码哈希） | 泄露可绕过 TOTP |
| `oauth_accounts` | 第三方身份 ↔ 本地账号映射 | 误删导致 OAuth 用户失去登录入口 |
| `system_settings` | 含 `is_secret=true` 的密钥类配置行 | 泄露密钥；误改影响全局运行时行为（缓存需「重新加载」而非仅删缓存） |
| `audit_logs` | 全站审计留痕 | 误删破坏合规证据链 |
| `submissions` / `self_tests` | <span class="noj-danger-col">`code`</span>、<span class="noj-danger-col">`artifact_storage_url`</span> | 用户代码/产物可能含隐私与密钥 |
| `ip_bans` / `user_bans` / `contest_clarifications` | 风控与申诉数据 | 误删放开攻击者；误加封禁误伤用户 |
| Redis 会话/限流键 | 见下文「Redis 键族」 | `DEL jwt:revoked:*` 会让已撤销令牌复活；`DEL` 评测队列会丢评测任务 |

---

## PostgreSQL 表

以下按业务域分组。表名即数据库中的真实表名（`public` schema，除非另有说明）。

### 身份与 RBAC

#### `users` <span class="noj-danger-zone">DANGER ZONE</span>

注册用户主表，存储账号凭据、资料、TFA 与软删除状态。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 用户 UUID；系统 root 用户固定为 `0` |
| `username` | text | NOT NULL；部分唯一索引 `users_active_username_unique`（仅 `deleted_at IS NULL`） | 用户名；已注销用户名可被重新占用 |
| `email` | text | NOT NULL；UNIQUE | 登录邮箱 |
| `email_verified` | boolean | NOT NULL；DEFAULT `true` | 本地注册邮箱是否已验证；历史迁移账号默认 true |
| `email_verify_token` | text | NULL | <span class="noj-danger-col">当前验证链接的 SHA-256 哈希</span>（不存明文令牌） |
| `email_verify_expires_at` | text | NULL | 验证链接过期时间（ISO 8601） |
| `password_hash` | text | NULL | <span class="noj-danger-col">bcrypt(cost 12) 哈希</span>；OAuth 新用户补设密码前为 NULL |
| `session_version` | integer | NOT NULL；DEFAULT `0` | 凭据变更时原子递增，用于撤销该用户此前签发的**全部**会话 |
| `bio` | text | NOT NULL；DEFAULT `''` | 个人简介（Markdown，上限 5000 字符） |
| `must_change_password` | boolean | NOT NULL；DEFAULT `false` | 引导管理员等账号下次登录须改密；中间件对非白名单请求返 403 |
| `community_activity_visibility` | text | NOT NULL；DEFAULT `'following'`；CHECK `hidden/following/everyone` | 社区活动可见范围 |
| `avatar_url` | text | NULL | 头像存储地址（`noj-storage://` 格式） |
| `tfa_secret_encrypted` | text | NULL | <span class="noj-danger-col">TOTP secret 的 AES-256-GCM 密文</span> |
| `tfa_enabled` | boolean | NOT NULL；DEFAULT `false` | 是否已启用二次验证 |
| `deleted_at` | text | NULL | 软删除时间；非 NULL 表示账号已注销、不可登录 |
| `created_at` / `updated_at` | text | NOT NULL | 创建 / 更新时间 |
| `search_vector` | tsvector | GENERATED ALWAYS（`username` A + `email` B） | 全文检索列，GIN 索引 `idx_users_search_vector` |

::: tip 运维注意
- **不要**直接改写 `password_hash` 或 `session_version`：前者会破坏登录校验，后者会强制目标用户全部会话失效。
- 注销（软删除）走 `deleted_at`，不要物理删除——大量表以 `users.id` 为外键，物理删除会级联清空用户内容。
:::

#### `oauth_accounts` <span class="noj-danger-zone">DANGER ZONE</span>

第三方（OAuth）身份与本地账号的关联表，**不保存** provider 的 access/refresh token。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 关联记录 UUID |
| `provider` | text | NOT NULL；与 `provider_user_id` 共同 UNIQUE | provider 标识 |
| `provider_user_id` | text | NOT NULL | provider 侧稳定用户 ID |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；索引 `idx_oauth_accounts_user_id` | 本地用户 |
| `provider_username` | text | NULL | provider 侧用户名快照 |
| `provider_email` | text | NULL | provider 侧邮箱快照 |
| `email_verified` | boolean | NOT NULL；DEFAULT `false` | provider 侧邮箱是否已验证 |
| `created_at` / `updated_at` | text | NOT NULL | 创建 / 更新时间 |

#### `check_ins`

每日签到记录，每用户每天一条。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 记录 UUID |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE | 用户 |
| `checkin_date` | text | NOT NULL；与 `user_id` 共同 UNIQUE | 签到日期（`YYYY-MM-DD`，UTC） |
| `streak` | integer | NOT NULL；DEFAULT `1` | 连续签到天数 |
| `created_at` | text | NOT NULL | 签到时间 |

#### `password_reset_tokens` <span class="noj-danger-zone">DANGER ZONE</span>

密码重置短期令牌；DB 只存哈希，URL 传明文。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 记录 UUID |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；索引 | 用户 |
| `token_hash` | text | NOT NULL；UNIQUE | <span class="noj-danger-col">令牌 SHA-256 hex 哈希</span>（不存明文） |
| `expires_at` | text | NOT NULL | 过期时间（`created_at` + 15 分钟） |
| `used_at` | text | NULL | 使用时间；NULL=未使用（单 SQL 原子消耗） |
| `created_at` | text | NOT NULL | 创建时间 |

#### `tfa_recovery_codes` <span class="noj-danger-zone">DANGER ZONE</span>

TFA 一次性恢复码；只存哈希。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 记录 UUID |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；索引 | 用户 |
| `code_hash` | text | NOT NULL | <span class="noj-danger-col">恢复码 SHA-256 hex 哈希</span> |
| `used_at` | text | NULL | 使用时间；NULL=未使用 |
| `created_at` | text | NOT NULL | 创建时间 |

#### `user_bans` <span class="noj-danger-zone">DANGER ZONE</span>

用户封禁记录，每条代表一次封禁操作（历史可追溯）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 记录 UUID |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；索引 | 被封禁用户 |
| `reason` | text | NOT NULL；DEFAULT `''` | 封禁原因 |
| `scope` | text | NOT NULL；DEFAULT `'platform'`；CHECK `platform/social` | `platform`=限制登录/评测等一切写操作；`social`=仅限制社区发布 |
| `banned_until` | text | NULL | 解封时间；NULL=永久 |
| `banned_at` | text | NOT NULL | 封禁时间 |
| `banned_by` | text | FK→`users(id)` ON DELETE SET NULL | 操作人 |
| `updated_at` | text | NOT NULL | 更新时间 |
| `unbanned_at` | text | NULL | 解封时间；NULL=当前活跃封禁 |
| `unbanned_by` | text | FK→`users(id)` ON DELETE SET NULL | 解封操作人 |

索引：`idx_user_bans_user`、部分索引 `idx_user_bans_active`（`unbanned_at IS NULL`）。

#### `roles`

RBAC 角色定义，支持继承与标记位。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 角色 UUID |
| `name` | text | NOT NULL；UNIQUE | 角色名 |
| `description` | text | NOT NULL；DEFAULT `''` | 描述 |
| `is_system` | boolean | NOT NULL；DEFAULT `false` | 系统保护角色，不可删除 |
| `is_default` | boolean | NOT NULL；DEFAULT `false` | 注册时自动分配 |
| `parent_id` | text | FK→`roles(id)` ON DELETE SET NULL；索引 | 父角色（继承） |
| `created_at` / `updated_at` | text | NOT NULL | 创建 / 更新时间 |

::: warning 管理员判定
`roles.is_admin` 列已于迁移 0032 删除。当前「管理员」判定 = 用户权限集包含 `admin:full_access`。
:::

#### `permissions`

RBAC 权限定义表，权限以 `resource:action` 唯一标识。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 权限 UUID |
| `resource` | text | NOT NULL；与 `action` 共同 UNIQUE | 资源域（如 `problem`、`system`） |
| `action` | text | NOT NULL | 动作（如 `create`、`settings`） |
| `description` | text | NOT NULL；DEFAULT `''` | 描述 |

#### `role_permissions`

角色-权限多对多关联。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `role_id` | text | NOT NULL；FK→`roles(id)` ON DELETE CASCADE；与 `permission_id` 共同 PK | 角色 |
| `permission_id` | text | NOT NULL；FK→`permissions(id)` ON DELETE CASCADE | 权限 |

#### `user_roles`

用户-角色多对多关联。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；与 `role_id` 共同 PK | 用户 |
| `role_id` | text | NOT NULL；FK→`roles(id)` ON DELETE CASCADE | 角色 |

### 题目、标签与题单

#### `problems`

题目主表。测试数据由支持包 zip 内的评测脚本自行管理，不在本表。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 题目 UUID |
| `title` | text | NOT NULL | 标题 |
| `description` | text | NOT NULL | 题面（Markdown） |
| `difficulty` | text | NOT NULL；DEFAULT `'medium'` | 难度 |
| `support_package_storage_url` | text | NULL | 支持包存储地址（`noj-storage://`） |
| `runtime_config` | jsonb | NULL；CHECK 为对象 | 双容器运行时配置（Evaluator + Solution）；客观题套卷为 NULL |
| `number` | integer | NOT NULL；与 `type` 共同 UNIQUE | 题号（同 `type` 内自增） |
| `owner_id` | text | NOT NULL；DEFAULT `'0'` | 题目所有者；默认 root |
| `type` | text | NOT NULL；DEFAULT `'U'`；CHECK `U/P` | `U`=用户题库，`P`=主题库 |
| `is_objective` | boolean | NOT NULL；DEFAULT `false` | true=客观题套卷（服务端即时判定，无评测容器） |
| `visibility` | text | NOT NULL；DEFAULT `'public'`；CHECK `public/private`（且 P 型恒 public） | 可见性 |
| `submission_mode` | text | NOT NULL；DEFAULT `'code'`；CHECK `code/artifact` | 提交模式：单文件代码 / zip 产物 |
| `artifact_max_size_mb` | integer | NULL | artifact 提交大小上限（MB）；NULL=使用系统硬上限 |
| `llm_config` | jsonb | NULL | 题目 LLM 能力与预算声明（`provider_id`/`model`/`max_calls`/`max_tokens`） |
| `created_at` / `updated_at` | text | NOT NULL | 创建 / 更新时间 |
| `search_vector` | tsvector | GENERATED ALWAYS（`title` A + `type`/`number` B） | 全文检索列，GIN 索引 |

#### `objective_questions`

客观题小题，必须绑定所属套卷。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 小题 UUID |
| `paper_id` | text | NOT NULL；FK→`problems(id)` ON DELETE CASCADE；索引 | 所属套卷（`is_objective=true`） |
| `sort_order` | integer | NOT NULL；DEFAULT `0`；与 `paper_id` 共同 UNIQUE | 卷内排序 |
| `type` | text | NOT NULL；CHECK `single/multiple/judge` | 单选 / 多选 / 判断 |
| `prompt` | text | NOT NULL | 题干（Markdown） |
| `options` | jsonb | NOT NULL；DEFAULT `[]` | 选项数组 `[{key,text}]`；判断题为空数组 |
| `answer` | jsonb | NOT NULL | 标准答案，如 `["A"]` / `["A","C"]` / `[true]` |
| `explanation` | text | NOT NULL；DEFAULT `''` | 答案解析（判卷后展示） |
| `created_at` / `updated_at` | text | NOT NULL | 创建 / 更新时间 |

#### `judge_images`

评测镜像白名单，管理员维护。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 记录 UUID |
| `image` | text | NOT NULL | 镜像名（可含标签） |
| `mode` | text | NOT NULL；DEFAULT `'exact'`；CHECK `exact/all_versions` | 精确匹配 / 匹配同名所有版本 |
| `kind` | text | NOT NULL；DEFAULT `'evaluator'`；CHECK `evaluator/solution` | 镜像角色：Evaluator / Solution |
| `description` | text | NOT NULL；DEFAULT `''` | 题目编辑器下拉中展示的介绍 |
| `created_at` / `updated_at` | text | NOT NULL | 创建 / 更新时间 |

#### `tags`

双类扁平标签（`category` 系统已退役）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 标签 UUID |
| `name` | text | NOT NULL；UNIQUE（全局唯一，跨 kind） | 标签名 |
| `kind` | text | NOT NULL；CHECK `problem/algorithm` | `problem`=题目标签（人人可见）；`algorithm`=算法标签（通过题目后可见） |
| `created_at` / `updated_at` | text | NOT NULL | 创建 / 更新时间 |

#### `problem_tags`

题目-标签多对多关联。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `problem_id` | text | NOT NULL；FK→`problems(id)` ON DELETE CASCADE；与 `tag_id` 共同 PK | 题目 |
| `tag_id` | text | NOT NULL；FK→`tags(id)` ON DELETE CASCADE | 标签 |

#### `trainings`

题单主表。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 题单 UUID |
| `public_id` | text | NOT NULL；UNIQUE；DEFAULT `tr-` + 8 位随机 | 对外短 ID |
| `title` | text | NOT NULL | 标题 |
| `description` | text | NOT NULL；DEFAULT `''` | 描述 |
| `visibility` | text | NOT NULL；DEFAULT `'private'`；CHECK `private/unlisted/public` | 可见性 |
| `is_pinned` | boolean | NOT NULL；DEFAULT `false` | 是否置顶 |
| `created_by` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；索引 | 创建者 |
| `created_at` / `updated_at` | text | NOT NULL | 创建 / 更新时间 |

#### `training_problems`

题单-题目关联。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `training_id` | text | NOT NULL；FK→`trainings(id)` ON DELETE CASCADE；与 `problem_id` 共同 PK | 题单 |
| `problem_id` | text | NOT NULL；FK→`problems(id)` ON DELETE CASCADE | 题目 |
| `position` | integer | NOT NULL；DEFAULT `0`；与 `training_id` 共同 UNIQUE | 题单内位置 |

### 提交与评测

#### `submissions` <span class="noj-danger-zone">DANGER ZONE</span>

提交记录，状态流转 `pending → judging → finished/error`。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 提交 UUID |
| `public_id` | text | NOT NULL；UNIQUE；DEFAULT `sub-` + 8 位随机 | 对外短 ID |
| `user_id` | text | NOT NULL；FK→`users(id)`；索引 | 提交者 |
| `problem_id` | text | NOT NULL；FK→`problems(id)`；索引 | 题目 |
| `contest_id` | text | FK→`contests(id)` ON DELETE SET NULL；索引 | 竞赛上下文；练习为 NULL |
| `language` | text | NOT NULL | 语言标识 |
| `code` | text | NOT NULL | <span class="noj-danger-col">提交的代码原文</span>（上限 100KB） |
| `file_name` | text | NULL | 提交文件名 |
| `artifact_storage_url` | text | NULL | <span class="noj-danger-col">artifact 提交的存储地址</span>（`noj-storage://`）；code 模式为 NULL |
| `client_ip` | text | NULL | <span class="noj-danger-col">风控用来源 IP</span>（可信代理解析，无法安全解析时为 NULL） |
| `status` | text | NOT NULL；DEFAULT `'pending'` | 评测状态 |
| `rejudge_seq` | integer | NOT NULL；DEFAULT `0` | 重测序列号，防止新旧结果竞态覆盖 |
| `judge_started_at` | text | NULL | 开始评测时间 |
| `judge_finished_at` | text | NULL | 完成评测时间 |
| `created_at` | text | NOT NULL | 创建时间 |

复合索引：`idx_submissions_user_id_created_at`、`idx_submissions_contest_problem_user`、`idx_submissions_contest_client_ip`。

::: warning artifact 提交
artifact 提交在评测完成后会**立即删除存储对象**，不支持重测。删除 `submissions` 行前请确认已评估对 `evaluation_results` 的级联影响。
:::

#### `evaluation_results`

评测结果，与提交 1:1。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 结果 UUID |
| `submission_id` | text | NOT NULL；FK→`submissions(id)`；唯一索引 `idx_eval_results_submission_id` | 对应提交（1:1） |
| `status` | text | NOT NULL | 结果状态（`finished` / `error`） |
| `score` | integer | NOT NULL；DEFAULT `0` | 分数 ×100 |
| `output` | text | NOT NULL；DEFAULT `''` | 评测输出（API 返回时截断至 8KB，DB 保留完整内容） |
| `details` | text | NOT NULL；DEFAULT `'{}'` | 逐用例详情（JSON 字符串），含 `cases[].hidden` 隐藏标记 |
| `time_ms` | integer | NULL | 耗时（毫秒） |
| `memory_kb` | integer | NULL | 内存（KB） |
| `created_at` | text | NOT NULL | 创建时间 |

结果写入使用 UPSERT（`onConflictDoUpdate`）语义，并配合 `rejudge_seq` 防止乱序覆盖。

#### `self_tests`

自测记录，与正式提交完全隔离（不参与统计/榜单/活动）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 自测 UUID |
| `user_id` | text | NOT NULL；FK→`users(id)`；索引 | 用户 |
| `problem_id` | text | NOT NULL；FK→`problems(id)`；索引 | 题目 |
| `language` | text | NOT NULL | 语言 |
| `code` | text | NOT NULL | <span class="noj-danger-col">自测代码原文</span> |
| `file_name` | text | NULL | 文件名 |
| `status` | text | NOT NULL；DEFAULT `'pending'`；CHECK `pending/judging/finished/error` | 自测状态 |
| `result_status` | text | NULL | 结果状态（`finished` / `error`） |
| `score` | integer | NOT NULL；DEFAULT `0` | 分数 ×100 |
| `output` | text | NOT NULL；DEFAULT `''` | 输出 |
| `details` | text | NOT NULL；DEFAULT `'{}'` | 详情 JSON 字符串 |
| `time_ms` / `memory_kb` | integer | NULL | 耗时 / 内存 |
| `judge_started_at` / `judge_finished_at` | text | NULL | 评测起止时间 |
| `created_at` | text | NOT NULL | 创建时间 |

#### `sse_events`

SSE 事件日志，供断线重连回放（`id` 作为 `Last-Event-ID`）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | serial | PK | 全局单调自增 ID |
| `channel` | text | NOT NULL；索引 `idx_sse_events_channel_id(channel, id)` | 事件频道 |
| `payload` | jsonb | NOT NULL | 事件负载 |
| `created_at` | text | NOT NULL | 创建时间 |

::: tip 保留策略
超过 **7 天**（`SSE_EVENT_RETENTION_DAYS`）的事件由后台任务每日清理；超期客户端改以 REST 全量校准。
:::

### 竞赛与客观题提交

#### `contests`

竞赛主表，状态由 `start_time` / `end_time` 动态计算，不持久化状态字段。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 竞赛 UUID |
| `public_id` | text | NOT NULL；UNIQUE；DEFAULT `ct-` + 8 位随机 | 对外短 ID |
| `title` | text | NOT NULL | 标题 |
| `description` | text | NOT NULL；DEFAULT `''` | 描述 |
| `start_time` / `end_time` | text | NOT NULL；CHECK 形态（UTC+毫秒+`Z`）且 `end_time > start_time` | 起止时间 |
| `ranking_visibility` | text | NOT NULL；DEFAULT `'public'`；CHECK `public/participants/hidden` | 榜单可见性 |
| `freeze_start_time` | text | NULL；CHECK 形态 | 封榜开始时间 |
| `freeze_duration_seconds` | integer | NOT NULL；DEFAULT `0`；CHECK `>= 0` | 结束前冻结时长（秒）；0=不封榜 |
| `type` | text | NOT NULL；CHECK `kaggle` | 竞赛类型 |
| `kind` | text | NOT NULL；DEFAULT `'public'`；CHECK `public/invite` | 公开 / 邀请制 |
| `config` | jsonb | NOT NULL；DEFAULT `{}`；CHECK 为对象 | 竞赛配置（含 `submission_limits` 等） |
| `is_public` | boolean | NOT NULL；DEFAULT `true` | 是否公开可见 |
| `password` | text | NULL | <span class="noj-danger-col">邀请码 / 口令</span> |
| `affect_global_ranking` | boolean | NOT NULL；DEFAULT `false` | 是否计入全局排行 |
| `created_by` | text | FK→`users(id)` ON DELETE SET NULL；索引 | 创建者 |
| `announcement` | text | NOT NULL；DEFAULT `''` | 竞赛公告 |
| `created_at` / `updated_at` | text | NOT NULL | 创建 / 更新时间 |

#### `contest_problems`

竞赛-题目关联，含题号标签与分值。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `contest_id` | text | NOT NULL；FK→`contests(id)` ON DELETE CASCADE；与 `problem_id` 共同 PK | 竞赛 |
| `problem_id` | text | NOT NULL；FK→`problems(id)` ON DELETE CASCADE | 题目 |
| `sort_order` | integer | NOT NULL；DEFAULT `0`；与 `contest_id` 共同 UNIQUE | 排序 |
| `label` | text | NOT NULL；与 `contest_id` 共同 UNIQUE | 题号标签（如 A、B） |
| `score` | integer | NOT NULL | 分值 |

#### `contest_participants`

竞赛参与者。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `contest_id` | text | NOT NULL；FK→`contests(id)` ON DELETE CASCADE；与 `user_id` 共同 PK | 竞赛 |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；索引 | 用户 |
| `registered_at` | text | NOT NULL | 报名时间 |

#### `contest_clarifications` <span class="noj-danger-zone">DANGER ZONE</span>

竞赛答疑。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 答疑 UUID |
| `contest_id` | text | NOT NULL；FK→`contests(id)` ON DELETE CASCADE；索引 | 竞赛 |
| `problem_id` | text | FK→`problems(id)` ON DELETE SET NULL | 关联题目（可选） |
| `sender_id` | text | NOT NULL；FK→`users(id)` | 发送者 |
| `content` | text | NOT NULL | 内容 |
| `reply_to_id` | text | FK→`contest_clarifications(id)` | 引用回复 |
| `is_public` | boolean | NOT NULL；DEFAULT `false` | 是否公开 |
| `created_at` | text | NOT NULL | 创建时间 |

#### `contest_ranking_snapshots`

正式竞赛成绩快照，每次发布修订新增版本，历史版本不可变。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 快照 UUID |
| `contest_id` | text | NOT NULL；FK→`contests(id)` ON DELETE CASCADE；与 `version` 共同 UNIQUE | 竞赛 |
| `version` | integer | NOT NULL | 版本号 |
| `status` | text | NOT NULL；DEFAULT `'published'` | 状态 |
| `note` | text | NOT NULL；DEFAULT `''` | 备注 |
| `rows` | jsonb | NOT NULL | 榜单行数据 |
| `created_by` | text | FK→`users(id)` ON DELETE SET NULL | 发布人 |
| `created_at` | text | NOT NULL | 创建时间 |

#### `objective_submissions`

客观题提交，服务端即时判定（不走评测队列）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 提交 UUID |
| `paper_id` | text | NOT NULL；FK→`problems(id)` ON DELETE CASCADE；索引 | 套卷 |
| `user_id` | text | NOT NULL；FK→`users(id)`；索引 | 用户 |
| `contest_id` | text | FK→`contests(id)` ON DELETE SET NULL；索引 | 竞赛上下文；练习为 NULL |
| `submission_type` | text | NOT NULL；CHECK `practice/contest` | 提交模式 |
| `answers` | jsonb | NOT NULL | 用户答案 `{question_id: [...]}` |
| `status` | text | NOT NULL；DEFAULT `'finished'` | 即时判定完成 |
| `score` | integer | NOT NULL；DEFAULT `0` | 卷面分 ×100（0–10000） |
| `details` | jsonb | NOT NULL；DEFAULT `{}` | 逐题判定 `{question_id:{correct,expected,given}}` |
| `created_at` | text | NOT NULL | 创建时间 |

唯一约束 `objective_submissions_contest_unique(paper_id, user_id, contest_id)`：同一竞赛内同一用户对同一套卷仅一条。

### 私信

#### `conversations`

私信会话；每对用户一个会话。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 会话 UUID |
| `user1_id` | text | NOT NULL；FK→`users(id)`；与 `user2_id` 共同 UNIQUE；CHECK `user1_id < user2_id` | 参与者（字典序小） |
| `user2_id` | text | NOT NULL；FK→`users(id)` | 参与者（字典序大） |
| `last_message_at` | text | NOT NULL；索引 | 最后消息时间（列表排序用，反范式缓存） |
| `created_at` | text | NOT NULL | 创建时间 |

#### `messages` <span class="noj-danger-zone">DANGER ZONE</span>

私信消息，支持文本/图片、回复、转发、编辑、撤回。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 消息 UUID |
| `conversation_id` | text | NOT NULL；FK→`conversations(id)` ON DELETE CASCADE；索引 | 会话 |
| `sender_id` | text | NOT NULL；FK→`users(id)`；索引 | 发送者 |
| `type` | text | NOT NULL；DEFAULT `'text'`；CHECK `text/image` | 消息类型 |
| `image_url` | text | NULL | <span class="noj-danger-col">图片存储地址</span>（`noj-storage://`）；`type=image` 时必填 |
| `reply_to_message_id` | text | FK→`messages(id)` ON DELETE SET NULL | 引用的消息 |
| `forwarded_from_user_id` | text | FK→`users(id)` ON DELETE SET NULL | 转发来源 |
| `content` | text | NOT NULL | <span class="noj-danger-col">文本内容</span> |
| `created_at` | text | NOT NULL | 创建时间 |
| `edited_at` | text | NULL | 编辑时间 |
| `recalled_at` | text | NULL | 撤回时间 |
| `edit_history` | text | NULL | <span class="noj-danger-col">编辑历史 JSON 数组</span>（仅后台保存，不对外展示） |

#### `message_reactions`

消息表情反应；同一用户对同一消息可加多个不同表情。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `message_id` | text | NOT NULL；FK→`messages(id)` ON DELETE CASCADE；索引 | 消息 |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE | 用户 |
| `emoji` | text | NOT NULL | 表情（取自固定集合） |
| `created_at` | text | NOT NULL | 创建时间 |

PK 为 `(message_id, user_id, emoji)`。

#### `conversation_reads`

会话已读位置。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE | 用户 |
| `conversation_id` | text | NOT NULL；FK→`conversations(id)` ON DELETE CASCADE | 会话 |
| `last_read_message_id` | text | NULL | 最后已读消息 ID；NULL=从未阅读 |
| `updated_at` | text | NOT NULL | 更新时间 |

PK 为 `(user_id, conversation_id)`。

#### `message_deletions`

单用户视角的消息删除记录（原始消息仍保留）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE | 用户 |
| `message_id` | text | NOT NULL；FK→`messages(id)` ON DELETE CASCADE；索引 | 消息 |
| `deleted_at` | text | NOT NULL | 删除时间 |

PK 为 `(user_id, message_id)`。

#### `conversation_preferences`

每用户每会话的偏好（备注名 / 免打扰）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE | 用户 |
| `conversation_id` | text | NOT NULL；FK→`conversations(id)` ON DELETE CASCADE；索引 | 会话 |
| `remark_name` | text | NULL | 备注名；NULL/空=使用真实用户名 |
| `is_muted` | boolean | NOT NULL；DEFAULT `false` | 消息免打扰 |
| `updated_at` | text | NOT NULL | 更新时间 |

PK 为 `(user_id, conversation_id)`。

### 社区

社区共 13 张表。内容类表（`community_posts` / `community_comments`）含用户生成内容，属敏感数据。

#### `community_boards`

社区讨论板块。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 板块 UUID |
| `slug` | text | NOT NULL；UNIQUE | 短标识 |
| `name` | text | NOT NULL | 名称 |
| `description` | text | NOT NULL；DEFAULT `''` | 描述 |
| `sort_order` | integer | NOT NULL；DEFAULT `0` | 排序 |
| `is_archived` | boolean | NOT NULL；DEFAULT `false` | 是否归档 |
| `created_at` / `updated_at` | text | NOT NULL | 创建 / 更新时间 |

#### `community_board_role_grants`

板块级角色授权；无记录时沿用全局社区 RBAC。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `board_id` | text | NOT NULL；FK→`community_boards(id)` ON DELETE CASCADE；与 `role_id` 共同 PK | 板块 |
| `role_id` | text | NOT NULL；FK→`roles(id)` ON DELETE CASCADE；索引 | 角色 |
| `can_read` | boolean | NOT NULL；DEFAULT `true` | 可读 |
| `can_post` | boolean | NOT NULL；DEFAULT `false` | 可发帖 |
| `can_moderate` | boolean | NOT NULL；DEFAULT `false` | 可管理 |

#### `community_posts` <span class="noj-danger-zone">DANGER ZONE</span>

题解 / 讨论 / 动态统一内容表。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 内容 UUID |
| `public_id` | text | NOT NULL；UNIQUE；DEFAULT `post-` + 8 位随机 | 对外短 ID |
| `type` | text | NOT NULL；CHECK `solution/discussion/moment` | 内容类型 |
| `author_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；索引 | 作者 |
| `problem_id` | text | FK→`problems(id)` ON DELETE CASCADE；索引 | 关联题目（题解） |
| `board_id` | text | FK→`community_boards(id)` ON DELETE SET NULL；索引 | 关联板块（讨论） |
| `title` | text | NULL | <span class="noj-danger-col">标题</span>（题解/讨论必填，动态为空） |
| `content` | text | NOT NULL | <span class="noj-danger-col">正文</span>（Markdown） |
| `status` | text | NOT NULL；DEFAULT `'published'`；CHECK `draft/pending/published/hidden/deleted` | 状态 |
| `is_locked` | boolean | NOT NULL；DEFAULT `false` | 是否锁定 |
| `is_pinned` | boolean | NOT NULL；DEFAULT `false` | 是否置顶 |
| `is_official` | boolean | NOT NULL；DEFAULT `false` | 官方题解标记 |
| `moderation_reason` | text | NULL | 审核原因 |
| `published_at` | text | NULL | 发布时间 |
| `created_at` / `updated_at` | text | NOT NULL | 创建 / 更新时间 |

`CHECK community_posts_context_check` 约束三种类型的字段组合（题解须有 `problem_id` 且无 `board_id`，讨论反之，动态两者皆空且无标题）。

#### `community_comments` <span class="noj-danger-zone">DANGER ZONE</span>

社区评论，仅允许一级回复。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 评论 UUID |
| `post_id` | text | NOT NULL；FK→`community_posts(id)` ON DELETE CASCADE；索引 | 所属帖子 |
| `author_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；索引 | 作者 |
| `parent_id` | text | FK→`community_comments(id)` ON DELETE CASCADE；索引 | 父评论（一级） |
| `content` | text | NOT NULL | <span class="noj-danger-col">评论内容</span> |
| `status` | text | NOT NULL；DEFAULT `'published'`；CHECK `pending/published/hidden/deleted` | 状态 |
| `moderation_reason` | text | NULL | 审核原因 |
| `created_at` / `updated_at` | text | NOT NULL | 创建 / 更新时间 |

#### `community_post_likes` / `community_comment_likes` / `community_bookmarks`

点赞与收藏关联表，结构一致。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `post_id` / `comment_id` | text | NOT NULL；FK→对应内容表 ON DELETE CASCADE；与 `user_id` 共同 PK | 目标内容 |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；索引 | 用户 |
| `created_at` | text | NOT NULL | 创建时间 |

#### `community_follows`

用户关注关系。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `follower_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；与 `followee_id` 共同 PK | 关注者 |
| `followee_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；索引 | 被关注者 |
| `created_at` | text | NOT NULL | 创建时间 |

`CHECK community_follows_not_self_check`：不能关注自己。

#### `community_activity_events`

可展示在动态流的系统活动（去重）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 事件 UUID |
| `actor_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；索引 | 触发者 |
| `type` | text | NOT NULL；CHECK `first_accepted/solution_published/contest_joined` | 事件类型 |
| `subject_type` / `subject_id` | text | NOT NULL | 事件对象 |
| `metadata` | jsonb | NOT NULL；DEFAULT `{}` | 附加数据 |
| `created_at` | text | NOT NULL | 创建时间 |

唯一约束 `community_activity_events_dedupe_unique(actor_id, type, subject_type, subject_id)`。

#### `community_reports` <span class="noj-danger-zone">DANGER ZONE</span>

举报记录；目标须为帖子/评论/私信之一。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 举报 UUID |
| `reporter_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；索引 | 举报人 |
| `post_id` | text | FK→`community_posts(id)` ON DELETE SET NULL；索引 | 被举报帖子（三选一） |
| `comment_id` | text | FK→`community_comments(id)` ON DELETE SET NULL；索引 | 被举报评论（三选一） |
| `message_id` | text | FK→`messages(id)` ON DELETE SET NULL；索引 | 被举报私信（三选一） |
| `content_type` | text | NOT NULL；DEFAULT `'post'` | 内容类型 |
| `sanction_id` | text | FK→`community_sanctions(id)` ON DELETE SET NULL | 关联处罚 |
| `ban_id` | text | FK→`user_bans(id)` ON DELETE SET NULL | 关联封禁 |
| `category` | text | NOT NULL；DEFAULT `'其他'`；CHECK 8 类枚举 | 举报分类 |
| `reason` | text | NOT NULL | 举报理由 |
| `content_snapshot` | text | NOT NULL | <span class="noj-danger-col">内容快照</span>（留证） |
| `status` | text | NOT NULL；DEFAULT `'pending'`；CHECK `pending/resolved/dismissed` | 状态 |
| `resolution` | text | NULL | 处理说明 |
| `resolved_by` | text | FK→`users(id)` ON DELETE SET NULL | 处理人 |
| `resolved_at` | text | NULL | 处理时间 |
| `updated_at` / `created_at` | text | NOT NULL | 时间 |

`CHECK community_reports_target_check`：`num_nonnulls(post_id, comment_id, message_id) = 1`。

#### `community_moderation_actions`

审核动作历史。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 动作 UUID |
| `moderator_id` | text | FK→`users(id)` ON DELETE SET NULL；索引 | 操作人 |
| `action` | text | NOT NULL | 动作 |
| `target_type` / `target_id` | text | NOT NULL；联合索引 | 目标 |
| `reason` | text | NOT NULL；DEFAULT `''` | 原因 |
| `metadata` | jsonb | NOT NULL；DEFAULT `{}` | 附加数据 |
| `created_at` | text | NOT NULL | 创建时间 |

#### `community_sanctions`

社区写操作处罚（不影响评测与登录）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 处罚 UUID |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；部分索引（活跃） | 用户 |
| `reason` | text | NOT NULL | 原因 |
| `expires_at` | text | NULL | 到期时间；NULL=永久 |
| `created_by` | text | FK→`users(id)` ON DELETE SET NULL；索引 | 创建人 |
| `created_at` / `updated_at` | text | NOT NULL | 时间 |
| `revoked_at` | text | NULL | 撤销时间；NULL=有效 |
| `revoked_by` | text | FK→`users(id)` ON DELETE SET NULL | 撤销人 |

#### `community_notifications`

社区通知。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 通知 UUID |
| `recipient_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；索引（含未读部分索引） | 接收者 |
| `actor_id` | text | FK→`users(id)` ON DELETE SET NULL；索引 | 触发者 |
| `type` | text | NOT NULL；CHECK `reply/like/follow/moderation/clarification/report/ban` | 类型 |
| `post_id` | text | FK→`community_posts(id)` ON DELETE SET NULL；索引 | 关联帖子 |
| `comment_id` | text | FK→`community_comments(id)` ON DELETE SET NULL；索引 | 关联评论 |
| `data` | jsonb | NOT NULL；DEFAULT `{}` | 附加数据 |
| `read_at` | text | NULL | 读取时间；NULL=未读 |
| `created_at` | text | NOT NULL | 创建时间 |

### 系统、审计与邮件

#### `system_settings` <span class="noj-danger-zone">DANGER ZONE</span>

系统设置 KV 表（运行时可变配置的持久化层）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `key` | text | PK | 设置键 |
| `value` | text | NOT NULL | <span class="noj-danger-col">JSON 编码字符串</span>（boolean/string/text 共存） |
| `description` | text | NOT NULL；DEFAULT `''` | 描述 |
| `is_secret` | boolean | NOT NULL；DEFAULT `false` | <span class="noj-danger-col">敏感字段标记</span>（读取时掩码） |
| `updated_at` | text | NOT NULL；索引 | 更新时间 |
| `updated_by` | text | FK→`users(id)` ON DELETE SET NULL | 最后修改人 |

::: warning 不要直接改库绕过服务层
`system_settings` 由 `services/system-settings.ts` 做严格类型校验与敏感字段掩码；直接 `UPDATE` 会绕过校验。**配置失效必须走「重新加载」而非仅删缓存**（缓存未命中不回查 DB，只删缓存会读到 env/默认值而非真实新值）。
:::

#### `announcements`

站内公告。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 公告 UUID |
| `public_id` | text | NOT NULL；UNIQUE；DEFAULT `ann-` + 8 位随机 | 对外短 ID |
| `title` | text | NOT NULL | 标题（1–100 字符） |
| `content` | text | NOT NULL | 正文（Markdown，1–50000 字符） |
| `banner_text` | text | NULL | 横幅文字（独立于正文，为空则不出横幅） |
| `is_pinned` | boolean | NOT NULL；DEFAULT `false` | 是否置顶 |
| `is_active` | boolean | NOT NULL；DEFAULT `true` | 是否发布中（false=已下架） |
| `created_by` | text | NOT NULL；FK→`users(id)` | 创建者 |
| `created_at` / `updated_at` | text | NOT NULL | 时间 |

#### `audit_logs` <span class="noj-danger-zone">DANGER ZONE</span>

审计日志，记录管理员与认证类操作。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 日志 UUID |
| `admin_id` | text | NULL；FK→`users(id)`；索引 | 操作人；认证类事件可能无 actor |
| `action` | text | NOT NULL；CHECK 枚举（见下）；索引 | 动作 |
| `target_type` | text | NULL | 目标类型 |
| `target_id` | text | NULL | 目标 ID |
| `detail` | jsonb | NOT NULL；DEFAULT `{}` | 详情 |
| `ip_address` | text | NOT NULL | 来源 IP |
| `created_at` | text | NOT NULL；索引 | 时间 |

`action` 的 `CHECK` 覆盖 `users.*`、`roles.*`、`problems.*`、`submissions.*`、`settings.update`、`auth.*`、`community.*`、`announcement.*`、`carousel.*`、`review.*`、`contest.*`、`ip_ban.*`、`judge_images.*`、`email_delivery.clear_suppression`、`llm_provider.*`、`llm_quota.upsert` 等。

::: tip 保留策略
超过 `AUDIT_LOG_RETENTION_DAYS`（默认 **90 天**，0=禁用清理）的记录由后台任务清理。
:::

#### `ip_bans`

IP 黑名单，支持裸 IP 与 CIDR。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 记录 UUID |
| `ip_or_cidr` | text | NOT NULL；索引 | IP 或 CIDR（如 `10.0.0.0/8`） |
| `reason` | text | NOT NULL；DEFAULT `''` | 原因 |
| `expires_at` | text | NULL；索引 | 到期时间；NULL=永久 |
| `created_at` / `updated_at` | text | NOT NULL | 时间 |
| `created_by` | text | FK→`users(id)` ON DELETE SET NULL | 创建人 |

#### `email_delivery_events`

邮件回调归一化事件；只保存收件地址哈希与脱敏展示值。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 事件 UUID |
| `provider` | text | NOT NULL；与 `provider_event_id` 共同 UNIQUE | 邮件服务商 |
| `provider_event_id` | text | NOT NULL | 服务商事件 ID |
| `event_type` | text | NOT NULL；CHECK `delivery/temporary_failure/permanent_bounce/complaint` | 事件类型 |
| `recipient_hash` | text | NOT NULL；索引 | 收件地址哈希 |
| `recipient_masked` | text | NOT NULL | 脱敏地址 |
| `reason_code` | text | NULL | 原因码 |
| `reason` | text | NULL | 原因 |
| `occurred_at` | text | NOT NULL；索引 | 发生时间 |
| `received_at` | text | NOT NULL | 接收时间 |

#### `email_suppressions`

永久退信/投诉抑制清单。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 记录 UUID |
| `recipient_hash` | text | NOT NULL；索引；部分唯一（`cleared_at IS NULL`） | 收件地址哈希 |
| `recipient_masked` | text | NOT NULL | 脱敏地址 |
| `reason` | text | NOT NULL | 原因 |
| `provider` | text | NOT NULL | 服务商 |
| `source_event_id` | text | NOT NULL | 来源事件 ID |
| `suppressed_at` | text | NOT NULL；索引 | 抑制时间 |
| `cleared_at` | text | NULL | 解除抑制时间 |
| `cleared_by` | text | NULL | 解除人 |

### 搜索

#### `search_entries`

统一搜索索引表，唯一写者是 search domain（源域通过 Redis 事件异步维护）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK；DEFAULT `gen_random_uuid()` | 索引 UUID |
| `entity_type` | text | NOT NULL；与 `entity_id` 共同唯一（`idx_search_entries_entity`） | 实体类型 |
| `entity_id` | text | NOT NULL | 实体 ID |
| `title` | text | NOT NULL；DEFAULT `''` | 标题（权重 A） |
| `body` | text | NOT NULL；DEFAULT `''` | 正文（权重 B） |
| `search_vector` | tsvector | GENERATED ALWAYS | 全文向量，GIN 索引 |
| `metadata` | jsonb | NOT NULL；DEFAULT `{}` | 元数据 |
| `owner_id` | text | NULL；索引 | 所有者 |
| `participant_ids` | text[] | NOT NULL；DEFAULT `'{}'`；GIN 索引 | 参与者 ID 列表 |
| `deleted_by_user_ids` | text[] | NOT NULL；DEFAULT `'{}'` | 已删除该消息的用户列表（其搜索结果中不可见） |
| `is_public` | boolean | NOT NULL；DEFAULT `false`；索引 | 是否公开 |
| `admin_only` | boolean | NOT NULL；DEFAULT `false` | 是否仅 admin 可见 |
| `is_active` | boolean | NOT NULL；DEFAULT `true` | 是否有效 |
| `created_at` / `updated_at` | text | NOT NULL；`updated_at` 有索引 | 时间 |

可选扩展：`idx_search_entries_title_trgm` / `idx_search_entries_body_trgm`（`pg_trgm` GIN，生产迁移创建）。

### 内容审核

#### `content_review_queue`

内容合规审核队列（UGC 同步 + 私信异步）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 记录 UUID |
| `content_type` | text | NOT NULL；CHECK `post/comment/message` | 目标类型 |
| `target_id` | text | NOT NULL；索引 | 目标内容主键 |
| `channel` | text | NOT NULL；CHECK `ugc/dm` | 来源渠道 |
| `status` | text | NOT NULL；CHECK `pending_review/approved/rejected/reviewed/dismissed` | 处理状态 |
| `review_provider` | text | NOT NULL | 判定 Provider（`mock/aliyun/tencent/none`） |
| `verdict` | text | NOT NULL；CHECK `pass/review/block/error` | 机器结论 |
| `label` | text | NULL | 命中分类标签（JSON 数组字符串） |
| `hit_words` | text | NULL | 命中词（JSON 数组字符串） |
| `risk_level` | text | NULL | 风险级别（`low/medium/high`） |
| `content_snapshot` | text | NOT NULL；DEFAULT `''` | <span class="noj-danger-col">送审内容快照</span>（私信仅文本） |
| `meta` | text | NOT NULL；DEFAULT `'{}'` | 上下文 JSON |
| `reviewed_by` | text | FK→`users(id)` ON DELETE SET NULL | 人工处置人 |
| `reviewed_at` | text | NULL | 处置时间 |
| `resolution` | text | NULL | 处置说明 |
| `action_taken` | text | NULL | 处置动作（留痕） |
| `created_at` / `updated_at` | text | NOT NULL | 时间 |

### 法律与合规

#### `legal_documents`

法律文档身份表；每类文档一行，`current_version` 指向最新已发布版本。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 文档 UUID |
| `kind` | text | NOT NULL；UNIQUE；CHECK `privacy/terms` | 隐私政策 / 服务条款 |
| `current_version` | integer | NOT NULL；DEFAULT `0` | 最新已发布版本；0=未发布 |
| `created_at` / `updated_at` | text | NOT NULL | 时间 |

#### `legal_document_versions`

法律文档版本（不可变历史，只追加）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 版本 UUID |
| `document_id` | text | NOT NULL；FK→`legal_documents(id)` ON DELETE CASCADE；与 `version` 共同 UNIQUE | 文档 |
| `version` | integer | NOT NULL | 版本号（单调递增） |
| `content` | text | NOT NULL | Markdown 正文 |
| `content_hash` | text | NOT NULL | 规范化内容 SHA-256（同意记录据此绑定） |
| `change_summary` | text | NULL | 变更摘要 |
| `is_material` | boolean | NOT NULL；DEFAULT `false`；索引 | 是否重大变更（触发重新同意） |
| `published_at` | text | NOT NULL | 发布时间 |
| `created_by` | text | FK→`users(id)` ON DELETE SET NULL | 创建人 |
| `tsa_provider` | text | NULL | 时间戳 Provider 标识 |
| `tsa_token` | text | NULL | RFC 3161 TimeStampToken（base64） |
| `tsa_chain` | text | NULL | 时间戳证书链（base64） |
| `tsa_query` | text | NULL | 原始 RFC 3161 请求（base64） |
| `tsa_timestamp` | text | NULL | 时间戳签发时间 |

#### `user_consents`

用户同意记录（PIPL 履责证据），保留历史多行。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 记录 UUID |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；与后两者共同 UNIQUE | 用户 |
| `document_kind` | text | NOT NULL | 文档类型（与 `legal_documents.kind` 对齐） |
| `version` | integer | NOT NULL | 同意版本 |
| `content_hash` | text | NOT NULL | 同意时该版本内容哈希 |
| `agreed_at` | text | NOT NULL | 同意时间 |
| `ip` | text | NULL | 同意来源 IP |
| `user_agent` | text | NULL | 同意时 User-Agent |

#### `data_requests`

PIPL 删除/更正请求（内容类），状态机 `pending → processing → resolved/rejected`。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 请求 UUID |
| `user_id` | text | NOT NULL；FK→`users(id)` ON DELETE CASCADE；索引 | 申请人 |
| `kind` | text | NOT NULL；CHECK `delete/correct` | 删除 / 更正 |
| `target_type` / `target_id` | text | NOT NULL / NULL | 请求对象 |
| `detail` | text | NOT NULL | 申请人说明 |
| `status` | text | NOT NULL；DEFAULT `'pending'`；CHECK `pending/processing/resolved/rejected`；索引 | 状态 |
| `handled_by` | text | FK→`users(id)` ON DELETE SET NULL | 处理人 |
| `handled_at` | text | NULL | 处理时间 |
| `resolution` | text | NULL | 处理结果说明 |
| `created_at` / `updated_at` | text | NOT NULL | 时间 |

### 首页轮播

#### `carousel_slides`

首页轮播（与公告解耦）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 幻灯片 UUID |
| `kind` | text | NOT NULL；CHECK `image/text` | 图片 / 渐变文案 |
| `image_storage_url` | text | NULL | 图片地址（`kind=image` 必填） |
| `title` | text | NULL | 主标题（`kind=text` 必填） |
| `subtitle` | text | NULL | 副标题 |
| `gradient_key` | text | NULL | 渐变预设键（`kind=text`） |
| `link_url` | text | NULL | 跳转地址；为空则整卡不可点 |
| `sort_order` | integer | NOT NULL；DEFAULT `0`；索引 | 排序（升序） |
| `is_enabled` | boolean | NOT NULL；DEFAULT `true` | 是否启用 |
| `created_at` / `updated_at` | text | NOT NULL | 时间 |

### LLM 网关表（noj-llm-gateway）

这三张表物理上位于**同一 PostgreSQL 库**，但**逻辑所有权与迁移归 `noj-llm-gateway`**（迁移目录 `noj-llm-gateway/drizzle/`，记账表 `llm_schema_migrations`）。它们与 noj-core 表同库不同"迁移系统"，排查时不要指望在 `noj-core/drizzle/` 里找到它们最新的定义。

#### `llm_providers` <span class="noj-danger-zone">DANGER ZONE</span>

上游 LLM Provider（OpenAI 兼容服务）配置。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | Provider UUID |
| `name` | text | NOT NULL；索引 `idx_llm_providers_name` | 名称 |
| `base_url` | text | NOT NULL | 上游 API Base URL |
| `cost_per_1k_tokens` | double precision | NOT NULL；DEFAULT `0` | 每 1K token 费用（用于用量估算；0=不计费） |
| `encrypted_api_key` | text | NOT NULL | <span class="noj-danger-col">上游 API Key 的 AES-256-GCM 信封加密密文</span>（主密钥 `NOJ_LLM_STORE_KEY`） |
| `enabled` | boolean | NOT NULL；DEFAULT `true` | 是否启用；停用后新评测不能选用 |
| `created_at` / `updated_at` | text | NOT NULL | 时间 |

::: danger 为什么它是首要 DANGER ZONE
`encrypted_api_key` 是平台调用上游 LLM 的**付费凭据**。虽然落库为密文（AES-256-GCM），但一旦连同 `NOJ_LLM_STORE_KEY` 一起泄露（例如整库导出 + 环境变量泄露），攻击者即可解密并盗刷上游账户。

- 导出/备份该表时必须按**密文级敏感数据**处理。
- 误删 Provider 行会导致所有引用该 Provider 的 LLM 题评测失败。
- `model` 列已于迁移 `0003` 删除：默认模型改由 noj-core 平台设置 `llm_default_model` 统一决定。
:::

#### `llm_usage`

LLM 调用审计表；完整保留 `request_messages`，不自动清理。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 用量 UUID |
| `submission_id` | text | NOT NULL；索引 | 提交 ID |
| `problem_id` | text | NOT NULL；索引 | 题目 ID |
| `user_id` | text | NOT NULL；索引 | 用户 ID |
| `provider_id` | text | NOT NULL；索引 | Provider ID |
| `model` | text | NOT NULL | 模型 |
| `request_messages` | jsonb | NOT NULL | <span class="noj-danger-col">发给上游的完整原始 messages</span>（可能含题目上下文与用户输入） |
| `request_params` | jsonb | NOT NULL；DEFAULT `{}` | 生成参数快照（temperature / max_tokens 等） |
| `prompt_tokens` | integer | NOT NULL；DEFAULT `0` | 提示 token 数 |
| `completion_tokens` | integer | NOT NULL；DEFAULT `0` | 生成 token 数 |
| `total_tokens` | integer | NOT NULL；DEFAULT `0` | 总 token 数 |
| `cached_prompt_tokens` | integer | NOT NULL；DEFAULT `0` | 上游返回的缓存命中 prompt token 数 |
| `billed_prompt_tokens` | integer | NOT NULL；DEFAULT `0` | 实际计费 prompt token（`prompt_tokens` - 缓存） |
| `billed_total_tokens` | integer | NOT NULL；DEFAULT `0` | 实际计费总 token |
| `estimated_cost` | integer | NOT NULL；DEFAULT `0` | 估算费用 |
| `latency_ms` | integer | NOT NULL；DEFAULT `0` | 延迟（毫秒） |
| `status` | text | NOT NULL；DEFAULT `'ok'` | 状态 |
| `error_code` | text | NULL | 错误码 |
| `prompt_hash` | text | NOT NULL | 请求内容哈希（去重 / 风控） |
| `created_at` | text | NOT NULL；索引 | 时间 |

#### `llm_quotas`

LLM 配额配置（按用户 / 题目 / 全局维度，日或月窗口）。

| 列 | 类型 | 约束 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 配额 UUID |
| `scope_type` | text | NOT NULL；与 `scope_id`、`window_type` 联合索引 | 作用域：`user/problem/global` |
| `scope_id` | text | NOT NULL；DEFAULT `''` | 作用域 ID；`global` 时为空串 |
| `window_type` | text | NOT NULL；DEFAULT `'day'` | 窗口：`day/month` |
| `max_calls` | integer | NOT NULL；DEFAULT `0` | 最大调用次数 |
| `max_tokens` | integer | NOT NULL；DEFAULT `0` | 最大 token 数 |
| `max_cost` | integer | NOT NULL；DEFAULT `0` | 最大费用 |
| `created_at` / `updated_at` | text | NOT NULL | 时间 |

::: tip 配额缺省
表中无对应记录时，网关使用安全 fallback（环境变量 `NOJ_LLM_DEFAULT_<SCOPE>_<WINDOW>_<FIELD>`，共 24 个），**缺失配额不会视为无限**。
:::

### 物化视图

#### `user_rankings`

全局排行榜物化视图（非普通表），由迁移 `0020` / `0028` / `0059` 重建。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | text | 用户 ID（唯一索引 `idx_user_rankings_user_id`） |
| `username` | text | 用户名 |
| `total_submissions` | int | 总提交数 |
| `solved_count` | int | 去重后的解题数（仅计非竞赛或 `affect_global_ranking=true` 的竞赛） |
| `accepted` | int | 通过提交数（`status='finished' AND score>0`） |
| `acceptance_rate` | float | 通过率 |
| `rank` | int | 排名（`idx_user_rankings_rank`） |

::: warning 刷新与依赖
该视图在 noj-core 侧通过 `REFRESH MATERIALIZED VIEW CONCURRENTLY user_rankings` 刷新（排名相关操作后、带节流）。PGlite 测试模式不支持物化视图，会自动跳过。**只读**：不要对其执行 `UPDATE`/`DELETE`。
:::

### 迁移记账表

以下表由迁移系统自动维护，**不要手工修改**：

| 表 | 所有者 | 说明 |
| --- | --- | --- |
| `drizzle.__drizzle_migrations` | noj-core | Drizzle 迁移记录（schema 默认 `drizzle`；测试分片下随 `TEST_SCHEMA` 移动） |
| `llm_schema_migrations` | noj-llm-gateway | 网关自有迁移记录（避免与 core 迁移互相干扰） |

---

## Redis 键族

Redis 承担 MQ、限流、撤销、观测与跨副本事件分发。以下按用途分组；`类型` 为 Redis 数据结构；`写入方` 指出哪个进程会创建/修改该键；`能否删除` 给出运维判断。

::: danger 通用警告
- **不要**对评测队列执行 `DEL`：会直接丢弃待评测任务。
- **不要**随意 `DEL jwt:revoked:*`：会让已撤销的令牌"复活"。
- 限流键删除等同于**临时放宽限流**，可用于误伤恢复，但会影响正在进行的攻击防护。
- 跨副本共享状态全部走 Redis；本页中的多数键在重启后会以自然过期方式恢复，但**队列类键携带的是真实待处理数据**。
:::

### 评测 MQ（noj-core ↔ noj-judge）

| 键模式 | 类型 | 写入方 | TTL | 作用 | 能否删除 |
| --- | --- | --- | --- | --- | --- |
| `noj:judge:queue:high` / `:medium` / `:low` | List | noj-core LPUSH；noj-judge RPOPLPUSH | 无 | 三级优先级评测任务队列（前缀由 `JUDGE_QUEUE` 决定） | **否**（丢任务） |
| `noj:judge:queue:{high,medium,low}:processing` | List | noj-judge（RPOPLPUSH/BRPOPLPUSH） | 无 | 已领取未确认任务；崩溃残留在 core sweeper 超时（约 10 分钟起，随最大时限放宽）后重投 | **否** |
| `noj:judge:queue:{high,medium,low}:dead` | List | noj-judge（坏消息） | 无 | 反序列化失败的死信，便于审计 | 谨慎（审计后可清） |
| `noj:judge:results` | List | noj-judge LPUSH；noj-core BRPOP | 无 | 评测结果队列 | **否**（丢结果） |
| `noj:judge:results:processing` | List | noj-core（消费者移入） | 无 | 已取未确认结果；超时 2 分钟由 sweeper 重投 | **否** |

::: tip 背压
每级队列有容量上限（high 5000、medium 10000、low 20000），入队前用 Lua 原子检查；满则拒绝新提交。主队列**不设 TTL**（空列表 Redis 自动删除 key；对非空列表设 TTL 会连未消费任务一起删）。
:::

### 评测公平调度与观测（noj-judge）

| 键模式 | 类型 | 写入方 | TTL | 作用 | 能否删除 |
| --- | --- | --- | --- | --- | --- |
| `noj:judge:active_users:<user_id>` | ZSet | noj-judge（Lua 原子 claim） | claim 级 + key 级兜底过期（约 2×claim TTL，最小 60s） | 每用户评测并发占用（member=`<instance>:<submission>`，score=占用时刻）；保证同一用户同时最多 1 个评测。旧 claim 按时间戳清理，崩溃可自愈 | 可（最坏是瞬时放宽互斥） |
| `noj:observability:judge:<instance_id>` | String | noj-judge（`SET ... EX`） | 有（心跳 TTL，见源码常量） | Judge worker 心跳快照（活跃任务、完成/失败计数、缓存大小等），供 core 聚合平台指标 | 可（下一轮心跳重建） |

### 跨副本事件与 SSE（noj-core）

| 键模式 | 类型 | 写入方 | TTL | 作用 | 能否删除 |
| --- | --- | --- | --- | --- | --- |
| `noj:events:submission:<id>` | Pub/Sub 频道 | noj-core `publish` | 瞬时 | 单提交状态变更通知（SSE 推送） | 不适用（Pub/Sub） |
| `noj:events:queue` | Pub/Sub 频道 | noj-core | 瞬时 | 全局队列变更通知 | 不适用 |
| `noj:events:user:<id>` | Pub/Sub 频道 | noj-core | 瞬时 | 用户私信通知 | 不适用 |
| `noj:events:contest:<id>:ranking` | Pub/Sub 频道 | noj-core | 瞬时 | 竞赛排名变更 | 不适用 |
| `noj:events:contest:<id>:submission` | Pub/Sub 频道 | noj-core | 瞬时 | 竞赛新提交 | 不适用 |
| `noj:events:stats` | Pub/Sub 频道 | noj-core | 瞬时 | 统计数据变更 | 不适用 |
| `noj:events:announcements` | Pub/Sub 频道 | noj-core | 瞬时 | 公告变更 | 不适用 |
| `noj:events:settings` | Pub/Sub 频道 | noj-core | 瞬时 | **系统设置变更（跨副本缓存失效）** | 不适用（`FLUSHALL` 会中断缓存失效通知） |

::: warning 配置失效语义
收到 `noj:events:settings` 后，副本执行的是「**重新加载**」而非仅 `cache.delete()`：缓存未命中不回查 DB，只删缓存会读到 env/默认值而非真实新值。
:::

### 异步消费者队列（noj-core）

| 键模式 | 类型 | 写入方 | TTL | 作用 | 能否删除 |
| --- | --- | --- | --- | --- | --- |
| `noj:search:index` | List | 源域写库后 fire-and-forget LPUSH | 无 | 异步搜索索引投影队列；消费失败会永久滞留（无自动自愈），导致搜索索引静默落后 | 谨慎（丢索引事件→索引落后） |
| `noj:search:index:processing` | List | search 消费者 | 无 | 已取未确认索引事件 | 谨慎 |
| `noj:review:dm` | List | messaging 域 RPUSH | 无 | 私信异步内容审核队列 | 谨慎 |
| `noj:review:dm:processing` | List | review 消费者 | 无 | 已取未确认审核任务 | 谨慎 |

（各消费者自动登记进 sweeper 兜底表；坏消息进入对应 `:dead` 队列。）

### 登录 / 改密 / TFA 限流（noj-core）

namespace 默认 `login`；改密用 `pwchange`；TFA 用 `tfa`。

| 键模式 | 类型 | TTL | 作用 |
| --- | --- | --- | --- |
| `ratelimit:<ns>:ip:<ip>` | String | 登录窗口（默认 30s） | IP 维度固定窗口计数（默认 10 次） |
| `ratelimit:<ns>:acc:<user>` | String | 登录窗口（默认 30s） | 账号维度固定窗口计数（默认 5 次） |
| `<ns>fail:<user>` | String | 1 小时 | 连续登录失败计数；达阈值（默认 10）触发锁定 |
| `<ns>lock:<user>` | String | 锁定时长（默认 3600s） | 账号锁定标记；登录成功时清除 |

（`<ns>fail` / `<ns>lock` 的实际前缀为 `login` / `pwchange` / `tfa`，后接 `fail:` / `lock:`。）

::: tip Redis 抖动
限流相关路径在 Redis 不可用时 **fail-closed**（返回 503），避免被绕过。误伤恢复可删除对应键。
:::

### 搜索限流（noj-core）

| 键模式 | 类型 | TTL | 作用 |
| --- | --- | --- | --- |
| `ratelimit:search:ip:<ip>` | String | 搜索窗口（默认 30s） | 匿名 IP 维度计数（默认 60 次）；认证用户也用它做**粗粒度 IP 兜底**（`rate_limit_search_max_ip_total`） |
| `ratelimit:search:user:<user_id>` | String | 搜索窗口（默认 30s） | 登录用户维度计数（默认 120 次）；admin 跳过 |

### 写操作加固限流（noj-core）

统一前缀 `ratelimit:hardening:<key>`（`key` 已被小写化并截断至 128 字符）。

| 键模式示例 | 窗口 / 阈值 |
| --- | --- |
| `ratelimit:hardening:register:ip:<ip>` | 3600s / 100 |
| `ratelimit:hardening:password-reset:ip:<ip>` / `:email:<email>` | 3600s / 30、3600s / 10 |
| `ratelimit:hardening:email-verification:ip:<ip>` / `:user:<id>` | 60s / 1 |
| `ratelimit:hardening:message:user:<id>` | 60s / 60 |
| `ratelimit:hardening:submission:ip:<ip>` / `:user:<id>` | 60s / 120 |
| `ratelimit:hardening:self-test:ip:<ip>` / `:user:<id>` | 60s / 30、60s / 4 |
| `ratelimit:hardening:contest-submission:...` | 60s / 120 |
| `ratelimit:hardening:objective-submit:...` | 60s / 60 |
| `ratelimit:hardening:problem-create:...` / `problem-import:...` | 60s / 30、60s / 10 |
| `ratelimit:hardening:post-like:...` / `comment-like:...` / `bookmark:...` / `follow:...` | 60s / 120 |
| `ratelimit:hardening:report:...` | 60s / 30 |
| `ratelimit:hardening:contest-register:ip:<ip>:c:<contestId>` | 30s / 5 |

### 竞赛提交预算（noj-core）

| 键模式 | 类型 | TTL | 作用 |
| --- | --- | --- | --- |
| `contest:lim:<contestId>:u:<userId>:p:<problemId>` | String | 至竞赛结束 | 竞赛内单题提交次数预算（仅当题目配置了 `submission_limits`）；超限返回 429，所有提交（含 error）均计入 |

### JWT 撤销（noj-core）

| 键模式 | 类型 | TTL | 作用 |
| --- | --- | --- | --- |
| `jwt:revoked:<jti>` | String | 与 token 剩余有效期一致 | 已撤销 JWT 的 `jti`；值=撤销时间戳（ISO）。来源：登出、改密、封禁/降级等 |

::: danger
删除该键会让已撤销令牌**重新可用**。Redis 不可用时校验侧 fail-closed（503）。
:::

### LLM 网关限流与额度（noj-llm-gateway）

| 键模式 | 类型 | TTL | 作用 |
| --- | --- | --- | --- |
| `llm:rate:<user_id>:<minuteKey>` | String | 60s | 用户维度分钟速率计数（默认 60/min） |
| `llm:rate:ip:<ip>:<minuteKey>` | String | 60s | 有真实客户端 IP 时的 IP 维度分钟计数 |
| `llm:rate:sub:<submission_id>:<minuteKey>` | String | 60s | 无真实 IP（Evaluator 直连）时按 submission 隔离的分钟计数 |
| `llm:sub:<submission_id>:calls` / `:tokens` / `:cost` | String | 评测 token TTL | 单次提交的调用/ token /费用计数 |
| `llm:global:day:<YYYY-MM-DD>:calls/tokens/cost` | String | 至当日 UTC 结束 | 全局日额度计数 |
| `llm:global:month:<YYYY-MM>:...` | String | 至当月 UTC 结束 | 全局月额度计数 |
| `llm:user:<user_id>:day:<date>:...` / `:month:<month>:...` | String | 至窗口结束 | 用户维度额度计数 |
| `llm:problem:<problem_id>:day:<date>:...` / `:month:...` | String | 至窗口结束 | 题目维度额度计数 |
| `llm:user_problem:<user_id>:<problem_id>:day:<date>:...` / `:month:...` | String | 至窗口结束 | 用户×题目组合额度（防单用户打满共享题目桶） |
| `llm:token-ips:<submission_id>` | Set | 与 eval_token 剩余有效期 | 监控同一 submission 的 token 被多少个来源 IP 调用（仅告警不阻断） |

（各额度键后缀为 `:calls` / `:tokens` / `:cost`。）

::: tip 说明
分钟窗口键以 `minuteKey`（`YYYY-MM-DDTHH:MM`）结尾；日/月键以日期结尾并在窗口结束时整键过期。这些键均为**计数缓存**，删除只会临时放宽限流/额度，不损坏数据。
:::

---

## 运维速查

- **备份范围**：完整 PostgreSQL 备份应覆盖本文全部表；Redis 若仅做缓存/队列，可不做持久化，但**评测队列积压时重启会丢任务**，生产建议开启 AOF 或在上线维护窗口前排空队列。
- **不可手工维护的对象**：`drizzle.__drizzle_migrations`、`llm_schema_migrations`、`user_rankings` 物化视图（刷新由应用触发）。
- **改动前复核**：任何 `ALTER` / `DROP` / 批量 `UPDATE` / Redis `DEL` 前，先用 `\d+ <表名>`、`redis-cli TYPE <key>` 与源码二次确认，并在变更窗口内先行备份。
- **敏感数据导出**：涉及 DANGER ZONE 表（尤其 `llm_providers`、`users`、`oauth_accounts`、`system_settings`、`audit_logs`）必须脱敏/加密传输。

> 再次提醒：本文档**不保证完全准确**，可能随开发变动且不另行通知。以实际 Schema 与源码为准。
