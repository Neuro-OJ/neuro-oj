# 从 v0.10.6 逻辑升级至 v0.11

本文说明如何将存量 **v0.10.6** 实例安全迁移到 **v0.11**。由于 `v0.11` 引入了工作空间（Domain）边界、固定角色权限体系及统一通知模型，直接原地执行 `0116_peaceful_gorilla_man.sql` 与 `0132_eager_gamma_corps.sql` 会在非空存量库触发兼容守卫（PostgreSQL 错误码 `55000`）或迁移账本哈希校验失败，因此 **严禁使用 `noj-cli update` 对 v0.10.6 库执行原地升级**，统一采用「只读源库 → 全新空 v0.11 目标库」的逻辑迁移工具 `noj db upgrade-v010`。

::: warning 前置版本要求
- **最低且唯一支持的直接源版本为 `v0.10.6`（`drizzle.__drizzle_migrations` 精确到 `0115_ui_submission_mode`，共 115 条迁移）**。
- 更早的 `0.10.x` 版本须先在原版本链逐级升级至 `v0.10.6`（完成三级优先级队列等历史数据回填），再执行本指南。
:::

---

## 1. 架构背景：为何禁止原地 DDL 升级

1. **迁移 `0116` 与 `0132` 守卫**：`0116_peaceful_gorilla_man.sql` 拒绝存量旧 `U` 型题与旧竞赛数据；`0132_eager_gamma_corps.sql` 要求在空库环境下完成 RBAC 到固定角色的模型切换。
2. **SHA-256 迁移账本严格比对**：`noj-core` 与 `noj-llm-gateway` 启动时会逐条比对 `drizzle.__drizzle_migrations` 与发布集哈希，任何手工篡改迁移文件、跳过脚本或修改 `_journal.json` 的操作都会阻断服务启动。
3. **只读源库、原子提交、可快速回切**：逻辑迁移器对 `v0.10.6` 源库仅开启 `SET TRANSACTION READ ONLY` 只读事务，绝不改动源库；目标库写入包裹在单个原子事务中，任何外键/约束校验或行数核对失败都会完整回滚，旧库可直接作为回滚兜底。

---

## 2. 完整升级操作流程

### 步骤 1：全量备份与对象存储冻结保护

在停服窗口开始前，对旧实例完成物理备份并记录对象存储状态：

```bash
# 1. 备份 v0.10.6 PostgreSQL 数据库（含 Core 与同库 Gateway 表）
pg_dump --format=custom --no-owner --no-privileges \
  "$V010_SOURCE_DATABASE_URL" > "/var/backups/noj-v0.10.6-$(date +%F-%H%M).dump"

# 若 Gateway 使用独立数据库，同样备份该库
# pg_dump --format=custom --no-owner --no-privileges "$V010_GATEWAY_DATABASE_URL" > ...

# 2. 对 MinIO / S3 Bucket 数据目录拍快照或同步冷备（升级不修改现有对象 Key）
```

> [!IMPORTANT]
> 对象存储中的所有题目支持包与提交产物保留原 `storage_url` Key；**切勿在确认稳定前对新旧实例共享的 Bucket 触发对象垃圾清理**。

### 步骤 2：停止或排空 v0.10.6 写入流量

停止 `v0.10.6` 的 `noj-core`、`noj-judge`、`noj-llm-gateway` 与前端写入入口，确保迁移窗口期间没有新的评测入队、注册或发帖写入源库（只读快照备份完成后建议额外将源库升级账号权限收窄为只读）。

### 步骤 3：运行只读预检 `preflight`

在目标版本 `noj-core`（或旧库旁路环境）确认源库阻断项概况：

```bash
cd noj-core
DATABASE_URL="$V010_SOURCE_DATABASE_URL" \
  deno task preflight --json /tmp/noj-preflight.json --csv /tmp/noj-preflight.csv
```

若 `preflight` 返回退出码 `2`（检测到旧 `U` 型题或旧竞赛），属于预期情况——这正是需要走逻辑迁移而非原地 `db migrate` 的信号。

### 步骤 4：初始化全新空 v0.11 目标库（只建 schema）

新建独立的空 PostgreSQL 数据库（**禁止复用源库自身**），只用 `v0.11` 发布集执行 schema 迁移。目标库除迁移自带的 `'global'` 投影哨兵行外必须为空，因此：

- Core **只执行 `noj db migrate`**，不要执行 `noj init system`、`dev-setup` 或管理员引导（Root 用户、评测镜像、系统设置都由迁移器从源库带入）；
- Gateway **必须带 `--schema-only`**：不带该参数的 `db:migrate` 会写入默认配额（`llm_quotas`），迁移器随后会以 `TARGET_NOT_EMPTY` 拒绝。若已误写，可在目标库执行 `DELETE FROM llm_quotas;` 后重试。

#### 4a. Docker Compose 生产栈（`noj-cli` 安装，内置 `postgres` 容器）

Compose 栈中所有服务的 `DATABASE_URL` 都由 `.env.prod` 的 `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` 拼成，主机固定为 `postgres`。因此「切换到新库」= 在同一 `postgres` 容器里新建数据库并修改 `.env.prod` 的 `POSTGRES_DB`。以下在安装目录执行（`v0.10.6` 原库名假设为默认的 `noj`，新库名以 `noj_v011` 为例）：

```bash
alias dc='docker compose --env-file .env.prod -f docker-compose.prod.yml'

# 1. 在内置 postgres 容器中新建空库（POSTGRES_DB 只在首次初始化数据卷时生效，不会自动建库）
dc exec postgres sh -c 'createdb -U "$POSTGRES_USER" noj_v011'

# 2. 先把 .env.prod 中的 NOJ_VERSION 改为 v0.11 版本号，并把 POSTGRES_DB=noj 改为 POSTGRES_DB=noj_v011
#    （保留旧值备查，回滚时改回 POSTGRES_DB=noj 即可）

# 3. Core 只建 schema：覆盖 migrate 服务的入口，跳过其中的 `noj init system`
dc run --rm --no-deps --entrypoint /app/bin/noj migrate db migrate

# 4. Gateway 只建 schema：--no-deps 避免触发依赖的 migrate（含 init system）
dc run --rm --no-deps gateway-migrate --schema-only
```

> [!WARNING]
> 不要在此阶段执行 `noj-cli start` / `dc up`：`migrate` 服务会执行 `noj init system` 写入系统数据，`gateway-migrate` 不带参数会写入默认配额，二者都会让目标库不再为空。

#### 4b. 外部（托管）PostgreSQL 或源码部署

使用外部数据库时，服务读取的是各自配置中的完整 `DATABASE_URL`，`POSTGRES_DB` 不起作用。在数据库服务端新建空库后：

```bash
# Core：只执行迁移（连接串只经环境变量传入，避免出现在进程列表）
cd noj-core
DATABASE_URL="$V011_TARGET_DATABASE_URL" deno run -A scripts/noj.ts db migrate

# Gateway（共享库模式：与 Core 同一目标库）
cd ../noj-llm-gateway
DATABASE_URL="$V011_TARGET_DATABASE_URL" deno task db:migrate --schema-only
```

> [!NOTE]
> **独立 Gateway 数据库**：若 `v0.10.6` 的 Gateway 使用独立数据库，请按 Gateway 自身流程把独立库升级到 `v0.11`（对独立库执行 `deno task db:migrate` 即可，它不受「目标库必须为空」约束）。旧版默认模型（`system_settings.llm_default_*`）与模型别名（`llm_model_aliases`）保存在 **Core** 库，独立 Gateway 库无法自行回填，必须在步骤 5/6 通过 `NOJ_UPGRADE_GATEWAY_URL` 让迁移器转移（见下文）。

### 步骤 5：执行 `--dry-run` 只读预演并核查规划报告

**连接串一律只通过环境变量传入**：

- 不要使用 `deno task db:upgrade-v010 ...`：`deno task` 会把展开后的完整命令（含 `--source-url` 中的连接串与口令）回显到终端；
- 不要写 `... -- --source-url ...`：CLI 使用严格参数解析，独立的 `--` 会被当作未知参数拒绝；
- `--source-url` / `--target-url` / `--gateway-url` 参数会出现在进程列表与 shell 历史中，仅限一次性测试环境使用。

```bash
# 只在当前 shell 设置，不写入任何文件
read -rs NOJ_UPGRADE_SOURCE_URL && export NOJ_UPGRADE_SOURCE_URL   # 旧 v0.10.6 库
read -rs NOJ_UPGRADE_TARGET_URL && export NOJ_UPGRADE_TARGET_URL   # 新 v0.11 空库
# 仅独立 Gateway 库部署需要：
# read -rs NOJ_UPGRADE_GATEWAY_URL && export NOJ_UPGRADE_GATEWAY_URL
```

Compose 栈内置数据库的连接串形如 `postgres://<POSTGRES_USER>:<POSTGRES_PASSWORD>@postgres:5432/noj`（源）与 `.../noj_v011`（目标）。在 v0.11 镜像中运行（`-e 变量名` 不带值时从当前 shell 透传，口令不出现在命令行）：

```bash
dc run --rm --no-deps -T \
  -e NOJ_UPGRADE_SOURCE_URL -e NOJ_UPGRADE_TARGET_URL \
  --entrypoint /app/bin/noj migrate \
  db upgrade-v010 --dry-run --json > /tmp/noj-upgrade-dry-run.json
```

源码部署等价命令：

```bash
cd noj-core
deno run -A scripts/noj.ts db upgrade-v010 --dry-run --json > /tmp/noj-upgrade-dry-run.json
```

#### 访问边界决策（必需）

`v0.11` 的 `main` 工作空间对已发布且启用的题目按 ID 公开可读，比赛也不再识别邀请制与报名口令。若源库存在以下数据，迁移器（含 `--dry-run`）会以 `ACCESS_DECISION_REQUIRED` 拒绝，并在 `details` 中列出 ID，直到运维显式选择处置：

| 源数据 | 参数 | 含义 |
| --- | --- | --- |
| 已发布的私有题（`visibility != 'public'`） | `--private-problems disable` | **推荐**。题目绑定写入 `disabled_at`，任何人（含原所有者）均不可读；平台管理员逐题复核后再启用 |
| 同上 | `--private-problems expose` | 明确接受这些题目在 `main` 中按 ID 公开可读 |
| 非公开、邀请制或设有报名口令的比赛 | `--restricted-contests expose` | 明确接受其在 `main` 中公开列出、可直接报名（旧口令清空，报告中不含口令明文）。如不接受，请在源库先行处理这些比赛后再升级 |

确定后在上面的命令末尾追加相应参数重新执行 `--dry-run`，例如 `--private-problems disable --restricted-contests expose`。

#### 重点核查字段

- `archivedSummary.renumberedProblems`：`U` 题重排前后的题号对照（请同步周知出题人/链接引用方）
- `archivedSummary.privateProblems` / `restrictedContests`：访问边界处置清单
- `archivedSummary.orphanJobItems`：引用已删除题目的批量重测条目；原 `failed`/`skipped` 原样保留，其余状态（含进行中）改为 `skipped`，`reason_code='UPGRADE_PROBLEM_DELETED'`，均不关联题目绑定
- `archivedSummary.skippedMomentPosts` / `skippedMomentComments`：历史动态帖及其级联评论清退明细
- `archivedSummary.droppedSystemSettings` / `skippedAuditLogs` / `skippedMessageReports`：下线功能清理统计
- `gateway.detected` 与计数值：同库 LLM Gateway Provider、用量与配额识别状态
- `gateway.standalone`：独立 Gateway 库待转移的默认模型 / 别名数量（`dry-run` 中 `verified` 恒为 `false`，只做冲突检查）

若源库存在默认模型或别名、而目标 Core 库中没有同库 Gateway 表，迁移器会以 `GATEWAY_TARGET_REQUIRED` 拒绝：请设置 `NOJ_UPGRADE_GATEWAY_URL` 指向已升级到 v0.11 的独立 Gateway 库（Compose 中追加 `-e NOJ_UPGRADE_GATEWAY_URL`）。独立库中已有与源库不一致的配置时会以 `GATEWAY_TARGET_INVALID` 拒绝并列出冲突，不会覆盖。

### 步骤 6：正式执行逻辑升级

确认 `dry-run` 报告无误后，去掉 `--dry-run`、保留同样的环境变量与访问边界参数，在单事务内完成原子写入：

```bash
dc run --rm --no-deps -T \
  -e NOJ_UPGRADE_SOURCE_URL -e NOJ_UPGRADE_TARGET_URL \
  --entrypoint /app/bin/noj migrate \
  db upgrade-v010 --private-problems disable --restricted-contests expose \
  --json > /tmp/noj-upgrade-result.json
```

源码部署等价命令：

```bash
cd noj-core
deno run -A scripts/noj.ts db upgrade-v010 \
  --private-problems disable --restricted-contests expose \
  --json > /tmp/noj-upgrade-result.json
```

独立 Gateway 库的默认模型与别名在 Core 目标事务提交前写入 Gateway 库并逐行读回比对；Gateway 侧写入或校验失败时 Core 目标库整体回滚。Gateway 侧写入使用 `ON CONFLICT DO NOTHING` 且只接受与源库一致的已有行，重新执行是安全的。报告与错误输出均不包含任何连接串或口令。

### 步骤 7：切换流量与上线验收

1. **切换数据库**：
   - Compose 内置数据库：确认 `.env.prod` 中 `POSTGRES_DB` 已是新库（步骤 4a），`NOJ_VERSION` 为 v0.11，然后 `noj-cli start`。此时 `migrate` / `gateway-migrate` 在已升级的库上执行均为幂等（迁移账本已齐，`init system` 只补齐缺失的系统数据，默认配额只在缺失时写入）。
   - 外部数据库：将 `noj-core`、`noj-llm-gateway`（共享库模式）的 `DATABASE_URL` 指向新库；独立 Gateway 库保持原连接串。
2. **独立 Gateway 部署必须先核对再切流**：报告中 `gateway.standalone.verified` 必须为 `true`，并在 Gateway 库确认：

   ```sql
   SELECT domain_id, provider_id, model FROM llm_gateway_domain_settings;
   SELECT domain_id, alias, provider_id, model FROM llm_gateway_model_aliases ORDER BY alias;
   ```

   `domain_id` 应为 `00000000-0000-4000-8000-000000000001`（`main`），取值与旧库 `system_settings.llm_default_*` / `llm_model_aliases`（`default` 别名除外）一致。未核对通过前不要切换 LLM 流量。
3. 启动 `v0.11` `noj-core`、`noj-llm-gateway`、`noj-judge` 与 `noj-ui`，确认健康检查与迁移账本校验正常。
4. 在线核对以下关键状态：
   - 管理员登录与普通用户进入默认工作空间 `main`（`/w/main`）正常
   - 公开题、原 `U` 题新题号、题目支持包上传与历史评测尝试记录可正常访问；`disable` 处置的私有题对匿名用户不可见
   - 实例公告在首页/实例公告页可见（旧公告迁入为实例级，`domain_id` 为空）
   - 排行榜（`user_rankings` 物化视图已自动刷新）、竞赛榜单、题单列表显示正常
   - 已迁入 Gateway（同库或独立库）的 Provider 配置、默认模型与日/月配额生效
5. **回滚**（源库全程只读，未被修改）：
   - Compose 内置数据库：`noj-cli stop`，把 `.env.prod` 的 `POSTGRES_DB` 改回 `noj`、`NOJ_VERSION` 改回 `v0.10.6` 对应版本，再 `noj-cli start`；新库 `noj_v011` 可保留排查或 `dropdb` 后重做；
   - 外部数据库：把 `DATABASE_URL` 改回旧库并换回旧镜像；
   - 独立 Gateway 库：其 v0.11 schema 升级属于 Gateway 自身的升级流程，回滚请恢复步骤 1 中该库的备份；本工具在其中只新增了 `main` 域的默认模型/别名行。
6. **回滚保留期**：至少保留只读冻结状态的 `v0.10.6` 源库与步骤 1 备份 7 天以上。

---

## 3. 数据保留、转换与下线对照表

| 数据类别 | 源端 (`v0.10.6`) | 目标端 (`v0.11`) 处理策略 |
| --- | --- | --- |
| 默认工作空间 | 无 `domains` 概念 | 创建固定 ID `00000000-0000-4000-8000-000000000001`、slug `main` 的 `community` 工作空间；`owner_id` 选活跃非 Root 管理员中 ID 最小者，无则回退 `'0'` |
| 用户与权限 | RBAC 四表 (`roles` / `permissions` / `role_permissions` / `user_roles`) | 沿 `parent_id` 解析拥有 `admin:full_access` 的活跃用户及 `'0'` → `users.role='admin'`，其余 `'user'`；活跃非 Root 用户写入 `domain_memberships`；四张 RBAC 表与授权日志不再写入 |
| 题目与题号 | `problems(type='P'\|'U', number)` | 移除 `type`；`P` 题保持原题号，`U` 题按 `(number, created_at, id)` 顺延重编号至 `max(1000, maxP)+1` 起（避开碰撞）并记录到 `renumberedProblems`；补齐 `domain_problem_bindings` 与 `problem_binding_history`（`exact` 策略的 `answer_version_id` 记录锁定版本 `required_version_id`，与 `0116` 回填一致）；已发布私有题按 `--private-problems` 处置 |
| 题目版本循环引用 | `problems.latest_version_id` / `required_version_id` ↔ `problem_versions` | 两阶段提交：先以 `effective_version_mode='any'` 且指针置空插入 `problems`，写入 `problem_versions` 后再批量回填真实模式与版本指针 |
| 竞赛与题单 | `contests` / `contest_problems` / `trainings` | 非公开/邀请制/口令比赛须显式 `--restricted-contests expose`（归一为 `is_public=true`、`kind='public'`、口令清空）；竞赛绑定 `domain_id=main`、`secrecy_enabled=true` 并规范化 `.sssZ` 时间戳；`contest_problems` 关联对应 `domain_problem_binding_id`；`trainings.state` 对 `public`/`unlisted` 设为 `'published'`，`private` 设为 `'draft'` |
| 提交与评测尝试 | `submissions` / `objective_submissions` ↔ `evaluation_attempts` | 按 `upgraded_from_id` 拓扑序写入；跨两表按时间升序统一编号 `receipt_sequence` 并推进 PG 序列 `submission_receipt_sequence`；两阶段回填 6 个尝试指针列；无作业归属记录保持 `assignment_id=NULL` |
| 社区帖子与评论 | `community_posts` / `community_comments` | 保留 `solution`（绑定 `domain_problem_binding_id`）与 `discussion`；**跳过 `moment` 动态帖及级联评论/回复**并记录明细到 `archivedSummary` |
| 举报、通知与搜索 | `community_reports` / `community_notifications` / `search_entries` | `community_notifications` 并入统一 `notifications` 表（`follow`/`ban` 置 `domain_id=NULL`，引用已跳过动态的指针置空）；跳过私信类举报/搜索与已清理动态的举报/搜索；`search_entries` 移除 `deleted_by_user_ids` |
| 批量任务、公告与 SSE | `submission_job_items` / `announcements` / `sse_events` | 引用已删除题目的条目绑定置空，非 `failed`/`skipped` 转 `skipped` 并记入 `orphanJobItems`；公告迁入为实例级（`domain_id=NULL`）；`sse_events` 保留原 ID 并推进 serial 序列 |
| 存储与配额计量 | `storage_objects` / `domain_storage_objects` | 按平台对账口径收录草稿包、版本支持包与提交产物非空未删对象，汇总初始化 `domain_resource_counters`（`members` / `problems` / `storage_bytes`） |
| 审计日志与设置 | `audit_logs` / `system_settings` | 过滤 `0132`/`0133` 已移除的 `roles.*` 与 `community.board_role_grant_*` 审计动作，并将 `domain.member_roles` 规范为 `domain.member_role`；剔除 `tsa_*`、`private_messaging_enabled`、`content_review_*` 与点赞/关注/收藏设置键；若同时配置了 `llm_default_provider_id` 与 `llm_default_model` 则回填 `domain_llm_settings` |
| 同库 Gateway | `llm_providers` / `llm_usage` / `llm_quotas` | `llm_providers` 归入 `main`；`llm_usage` 补 `principal_type='user'`、`principal_id=NULL`；`llm_quotas` 保留 `scope_type='global'` 为 `domain_id=''` 其余归 `main`；非 `default` 别名回填 `llm_gateway_model_aliases`（`revision >= 1`）与默认模型表；独立 Gateway 库经 `NOJ_UPGRADE_GATEWAY_URL` 转移并读回校验 |
| 下线空置旧表 | 私信、点赞/收藏/关注、审核队列、轮播图、RBAC 表等 17 张表 + `community_notifications` | 不再迁移，源表原有行数记录至 `archivedSummary.droppedLegacyTables` 供运维归档备查 |
