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

### 步骤 4：初始化全新空 v0.11 目标库

新建独立的空 PostgreSQL 数据库（**禁止复用源库自身**），并用 `v0.11` 发布集执行全量 schema 迁移：

```bash
# 1. 执行 Core 全量迁移（0000..0144）
cd noj-core
DATABASE_URL="$V011_TARGET_DATABASE_URL" deno task db:migrate

# 2. 若采用单库共享模式（推荐且与 docker-compose 一致），在同一目标库执行 Gateway v0.11 迁移
cd ../noj-llm-gateway
DATABASE_URL="$V011_TARGET_DATABASE_URL" deno task db:migrate
```

> [!NOTE]
> 请勿在该空目标库上执行 `dev-setup` 或 `bootstrap admin` 后再迁入数据——除迁移自带的 `'global'` 投影哨兵行外，目标库所有业务表在运行 `upgrade-v010` 前必须为空。若采用独立 Gateway 数据库，请先在独立库完成 `noj-llm-gateway` 自身升级，工具检测到源/目标无同库 Gateway 表时会自动跳过该部分。

### 步骤 5：执行 `--dry-run` 只读预演并核查规划报告

使用只读预览模式核对所有数据转换规划（该模式不向目标库写入任何行）：

```bash
cd noj-core
deno run -A scripts/noj.ts db upgrade-v010 \
  --source-url "$V010_SOURCE_DATABASE_URL" \
  --target-url "$V011_TARGET_DATABASE_URL" \
  --dry-run --json > /tmp/noj-upgrade-dry-run.json
```

或使用 `deno task db:upgrade-v010 -- --source-url ... --target-url ... --dry-run`。重点人工核查以下字段：

- `archivedSummary.renumberedProblems`：`U` 题重排前后的题号对照（请同步周知出题人/链接引用方）
- `archivedSummary.skippedMomentPosts` / `skippedMomentComments`：历史动态帖及其级联评论清退明细
- `archivedSummary.droppedSystemSettings` / `skippedAuditLogs` / `skippedMessageReports`：下线功能清理统计
- `gateway.detected` 与计数值：同库 LLM Gateway Provider、用量与配额识别状态

### 步骤 6：正式执行逻辑升级

确认 `dry-run` 报告无误后，去掉 `--dry-run` 在单事务内完成原子写入：

```bash
cd noj-core
deno run -A scripts/noj.ts db upgrade-v010 \
  --source-url "$V010_SOURCE_DATABASE_URL" \
  --target-url "$V011_TARGET_DATABASE_URL" \
  --json > /tmp/noj-upgrade-result.json
```

也可通过环境变量 `NOJ_UPGRADE_SOURCE_URL` 与 `NOJ_UPGRADE_TARGET_URL` 传递连接串，避免命令行参数出现在进程列表；命令行与报告输出严禁包含任何数据库口令。

### 步骤 7：切换流量与上线验收

1. 将 `v0.11` 服务的 `DATABASE_URL` 指向已升级的 `$V011_TARGET_DATABASE_URL`，同一 Bucket 配置对接既有 MinIO/S3。
2. 启动 `v0.11` `noj-core`、`noj-llm-gateway`、`noj-judge` 与 `noj-ui`，确认健康检查与迁移账本校验正常。
3. 在线核对以下关键状态：
   - 管理员登录与普通用户进入默认工作空间 `main`（`/w/main`）正常
   - 公开题、原 `U` 题新题号、题目支持包上传与历史评测尝试记录可正常访问
   - 排行榜（`user_rankings` 物化视图已自动刷新）、竞赛榜单、题单列表显示正常
   - 若已迁入同库 Gateway，核对 Provider 配置、默认模型与日/月配额生效
4. **回滚保留期**：至少保留只读冻结状态的 `v0.10.6` 源库与步骤 1 备份 7 天以上。如切换窗口内遇阻塞问题，可将连接切回只读保护解冻前的 `v0.10.6` 库与对应镜像版本快速恢复。

---

## 3. 数据保留、转换与下线对照表

| 数据类别 | 源端 (`v0.10.6`) | 目标端 (`v0.11`) 处理策略 |
| --- | --- | --- |
| 默认工作空间 | 无 `domains` 概念 | 创建固定 ID `00000000-0000-4000-8000-000000000001`、slug `main` 的 `community` 工作空间；`owner_id` 选活跃非 Root 管理员中 ID 最小者，无则回退 `'0'` |
| 用户与权限 | RBAC 四表 (`roles` / `permissions` / `role_permissions` / `user_roles`) | 沿 `parent_id` 解析拥有 `admin:full_access` 的活跃用户及 `'0'` → `users.role='admin'`，其余 `'user'`；活跃非 Root 用户写入 `domain_memberships`；四张 RBAC 表与授权日志不再写入 |
| 题目与题号 | `problems(type='P'\|'U', number)` | 移除 `type`；`P` 题保持原题号，`U` 题按 `(number, created_at, id)` 顺延重编号至 `max(1000, maxP)+1` 起（避开碰撞）并记录到 `renumberedProblems`；补齐 `domain_problem_bindings` 与 `problem_binding_history` |
| 题目版本循环引用 | `problems.latest_version_id` / `required_version_id` ↔ `problem_versions` | 两阶段提交：先以 `effective_version_mode='any'` 且指针置空插入 `problems`，写入 `problem_versions` 后再批量回填真实模式与版本指针 |
| 竞赛与题单 | `contests` / `contest_problems` / `trainings` | 竞赛绑定 `domain_id=main`、`secrecy_enabled=true` 并规范化 `.sssZ` 时间戳；`contest_problems` 关联对应 `domain_problem_binding_id`；`trainings.state` 对 `public`/`unlisted` 设为 `'published'`，`private` 设为 `'draft'` |
| 提交与评测尝试 | `submissions` / `objective_submissions` ↔ `evaluation_attempts` | 按 `upgraded_from_id` 拓扑序写入；跨两表按时间升序统一编号 `receipt_sequence` 并推进 PG 序列 `submission_receipt_sequence`；两阶段回填 6 个尝试指针列；无作业归属记录保持 `assignment_id=NULL` |
| 社区帖子与评论 | `community_posts` / `community_comments` | 保留 `solution`（绑定 `domain_problem_binding_id`）与 `discussion`；**跳过 `moment` 动态帖及级联评论/回复**并记录明细到 `archivedSummary` |
| 举报、通知与搜索 | `community_reports` / `community_notifications` / `search_entries` | `community_notifications` 并入统一 `notifications` 表（`follow`/`ban` 置 `domain_id=NULL`，引用已跳过动态的指针置空）；跳过私信类举报/搜索与已清理动态的举报/搜索；`search_entries` 移除 `deleted_by_user_ids` |
| 存储与配额计量 | `storage_objects` / `domain_storage_objects` | 按平台对账口径收录草稿包、版本支持包与提交产物非空未删对象，汇总初始化 `domain_resource_counters`（`members` / `problems` / `storage_bytes`） |
| 审计日志与设置 | `audit_logs` / `system_settings` | 过滤 `0132`/`0133` 已移除的 `roles.*` 与 `community.board_role_grant_*` 审计动作，并将 `domain.member_roles` 规范为 `domain.member_role`；剔除 `tsa_*`、`private_messaging_enabled`、`content_review_*` 与点赞/关注/收藏设置键；若同时配置了 `llm_default_provider_id` 与 `llm_default_model` 则回填 `domain_llm_settings` |
| 同库 Gateway | `llm_providers` / `llm_usage` / `llm_quotas` | `llm_providers` 归入 `main`；`llm_usage` 补 `principal_type='user'`、`principal_id=NULL`；`llm_quotas` 保留 `scope_type='global'` 为 `domain_id=''` 其余归 `main`；非 `default` 别名回填 `llm_gateway_model_aliases`（`revision >= 1`）与默认模型表 |
| 下线空置旧表 | 私信、点赞/收藏/关注、审核队列、轮播图、RBAC 表等 17 张表 + `community_notifications` | 不再迁移，源表原有行数记录至 `archivedSummary.droppedLegacyTables` 供运维归档备查 |
