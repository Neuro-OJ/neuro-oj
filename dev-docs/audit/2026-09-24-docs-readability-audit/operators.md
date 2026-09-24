# operators 文档审计报告

> 面向读者的正确性 + 可读性审计，范围：`noj-docs/docs/operators/` 全部页面。
> 事实源以源码/配置为准；截图落盘 `/tmp/opencode/audit-shots/operators/`。

## 范围

| 文件 | 改前行数 | 改后行数 |
| --- | ---: | ---: |
| `index.md` | 32 | 40 |
| `production-deploy.md` | 284 | 316 |
| `capacity-baseline.md` | 73 | 76 |
| `observability.md` | 150 | 180 |
| `llm-call-capability.md` | 100 | 107 |
| `cli.md` | 93 | 116 |
| `judge-workers.md` | 312 | 342 |
| `email-delivery.md` | 36 | 42 |
| `admin-guide.md` | 150 | 165 |
| `legal-compliance.md` | 148 | 151 |
| `production-secrets.md` | 63 | 76 |
| `storage.md` | 3 | 3（迁移指针，未改） |
| **合计** | **1444** | **1614** |

## 正确性发现

| 位置 | 问题 | 证据（路径 + 符号） | 处置 |
| --- | --- | --- | --- |
| `production-deploy.md` §4 日常运维 | `noj-cli backup` 被列为“创建备份”命令，实际裸命令只报用法错误 | `noj-cli/src/cli.ts:1165` `dispatchProdBackup`；`cli.ts:1306-1311` `default` 分支打印「backup 需要子命令 create/verify/list/prune/restore/drill/schedule」并返回 `EXIT_USAGE`。`commands.ts:141-165` 列出的子命令无裸 `backup` | 已修正：改为 `noj-cli backup create`，并加 `::: tip` 说明必须带子命令 |
| `production-deploy.md` §5.1 演练示例 | 快照写成目录形态 `backups/snapshot-YYYYMMDD-HHMMSS`，与实现不符 | `noj-cli/src/prod/backup/container.ts:246-257` `containerFileName` = `snapshot-<YYYYMMDD-HHMMSS>${BACKUP_SUFFIX}`，`BACKUP_SUFFIX = ".nojbackup"`；`prod/backup/commands.ts:110` `assertContainerPath` 只接受 `.nojbackup`，目录形态被拒 | 已修正：示例改为 `snapshot-20260924-021500.nojbackup` |
| `production-deploy.md` §2 安装步骤 | 列出 6 个安装步骤，遗漏 passphrase 解析与 `<dir>/bin/noj-cli` 安装 | `noj-cli/src/prod/lifecycle.ts:202-216` `InstallStepName` 含 `passphrase` 与 `install-cli`；`lifecycle.ts:562-574`（`ensureCommandPassphrase`）、`lifecycle.ts:646-667`（`installCliBinary` 先于 `register`） | 已修正：补充为 7 步（新增“解析备份口令”与“安装 `<dir>/bin/noj-cli`”） |
| `production-deploy.md` §3 配置表 | `EMAIL_PROVIDER` 说“可直接跳过”，未说明 `disabled` 会锁死公开注册 | `noj-core/src/shared/config/production-config.ts:150-170` `validateEmail`；`noj-core/src/main.ts:198-207` 邮件未就绪时禁止公开注册 | 已修正：改为“`disabled` 时邮箱验证/密码找回不可用，公开注册被禁止”，并链接后台管理指南 |
| `production-deploy.md` §3 配置表 | `DOMAIN` 一行未澄清它只在安装向导中用于生成 `APP_URL`，不直接注入容器 | `docker-compose.prod.yml` 全文无 `DOMAIN`；`noj-cli/src/prod/config.ts:201,1040-1052` 仅用于站点地址校验与向导默认值 | 已修正说明 |
| `production-deploy.md` §5 | “`migrate` 服务本身已按顺序执行…”措辞含糊，未点明是 compose 一次性服务 | `docker-compose.prod.yml:80-99` `migrate` 服务 `entrypoint` 跑 `db migrate && init system` | 已在 `cli.md` 对应处点明（`production-deploy.md` 原句正确，未改事实） |
| `production-secrets.md` | 三处命令写作 `noj config check`，真实命令是 `noj-cli config check` | `noj-cli/src/cli.ts:980-989` `case "config"`（仅支持 `check` 子命令）；`noj-cli/README.md:54` `noj-cli config check` | 已修正（部署前检查、S3、邮件三处） |
| `production-secrets.md` | `EMAIL_PROVIDER`、`JWT_SECRET`/`TFA_ENCRYPTION_KEY` 未标注属 bootstrap（env-owned，后台不可热改） | `noj-core/src/shared/config/settings-registry.ts:220-227`（`email_provider` scope=bootstrap）；`noj-core/src/domains/system/services/system-settings.ts:577-582` `updateSetting` 对 bootstrap 键抛 `ValidationError` | 已修正：加 `::: warning` 注明 bootstrap 与重启要求 |
| `observability.md` §Prometheus | `deno task storage:audit -- …` 命令被拆进多行行内代码，复制会断行；且指标名写成 `noj_storage_orphan_*` | `noj-core/deno.json:16` `storage:audit`；`noj-core/src/domains/system/services/storage/audit.ts:155-171` 实际指标为 `noj_storage_orphan_objects` / `noj_storage_orphan_bytes` / `noj_storage_missing_references` | 已修正：改为代码块，指标名写成真实名 |
| `observability.md` §常见故障「评测队列堆积」 | blockquote 之后残留一个孤立编号项 `3.`，渲染成断裂列表 | 原文 `observability.md:126-129`；VitePress 有序列表被打断 | 已修正：合并为第 4 步 |
| `observability.md` §备份过期 | 指向 `deploy/monitoring/README.md` “第 2 节”讲 textfile，实际在第 4 节 | `deploy/monitoring/README.md:78-104` §4「node_exporter 与备份新鲜度指标」；§2 是「抓取目标」 | 已修正为“第 4 节” |
| `observability.md` §Prometheus | 只写了抓 `core:8000`，漏掉 `llm-gateway:8001`（后者 job 名写错会静默无数据） | `deploy/monitoring/prometheus.yml` 的 `scrape_configs` 同时含 `noj-core` 与 `noj-llm-gateway`；`deploy/monitoring/README.md:55-61` | 已修正：补上 `llm-gateway:8001` 与目标名约束 |
| `legal-compliance.md` §5 留存期限 | 表格把 `sse_event_retention_days` 当成可配置键、默认写“—”；该键不存在，实际是不可配置常量 7 天 | `noj-core/src/shared/sse/sse-events.ts:15` `SSE_EVENT_RETENTION_DAYS = 7`；`settings-registry.ts` 全文无 `sse_event_retention_days`（`rg` 零命中） | 已修正：改为“源码常量（无配置键）”，默认 7，并注明前两项为 bootstrap |
| `admin-guide.md` §系统设置 | 把 `email_provider` 与 `audit_log_retention_days` 列在“运行时可改”表里，实际二者为 bootstrap、后台只读 | `settings-registry.ts:224`（`email_provider` envKey+scope bootstrap）；`:944-954`（`audit_log_retention_days` scope=bootstrap）；`noj-ui/pages/admin/settings.vue:186-193` 区分 runtime/bootstrap；`system-settings.ts:577-582` | 已修正：拆成“运行时配置（可编辑）/ 环境配置（只读）”两区表 |
| `admin-guide.md` §审计日志 | 未说明 `AUDIT_LOG_RETENTION_DAYS` 属 bootstrap | 同上；`settings-registry.ts:949` envKey | 已修正：注明环境变量键与重启要求 |
| `llm-call-capability.md` §4 配额 | 说配额在「LLM 用量 / 配额」面维护；管理端实际只有 `/admin/llm/providers` 与 `/admin/llm/usage`，配额走接口 | `noj-ui/pages/admin/llm/` 仅 `providers.vue`、`usage.vue`（`rg quotas/scope_type` 零命中）；`noj-core/src/domains/admin/routes/gateway.ts:131-180` `GET/POST /llm/quotas`；`admin-guide.md:141` 原文亦为“通过后台接口维护” | 已修正：改为明确接口路径的表述 |
| 跨页：`operators/judge-workers.md` → `production-deploy.md` | 链接 `#3-配置说明` 锚点错误 | VitePress 对数字开头标题生成 `_3-配置说明`（本地 5173 `--dump-dom` 实测）；`production-deploy.md` 无自定义 `{#...}`，手写 `#3-…` 不解析 | 已修正：改为页面级链接 |
| 跨页：`production-secrets.md` → `production-deploy.md` | 手写锚点 `#_5-1-备份-文件校验与隔离恢复演练` 脆弱 | 同上（数字/中文锚点易漂移） | 已修正：改为页面级链接 |
| `operators/index.md` | 文档清单为长散列表，缺“建议阅读顺序” | —（可读性） | 已修正：加阅读顺序 + 表格化 |

> 说明：`production-deploy.md` §5 的 BYOK 升级核查（`DELETE FROM llm_providers WHERE created_by <> '0'`）已核对正确：
> `noj-llm-gateway/drizzle/0002_remove_byok_created_by.sql:3` 正是该语句，`problems.llm_config->>'provider_id'` 引用亦属实。

## 可读性改进

| 页面 | 改动 | 理由 |
| --- | --- | --- |
| `index.md` | 新增“建议阅读顺序”；两组长列表改为表格 | 运营者需要先知道从哪读起；表格扫读成本远低于散列 |
| `production-deploy.md` | 开头补 `::: tip 阅读顺序`；`::: warning` 非交互零写入；安装步骤编号化；`backup` 子命令 tip；BYOK 悬空引用 `::: warning`；`::: danger` 口令遗失、`uninstall --all` | 长流程改编号步骤；不可逆/高危操作显式 danger；易错点 warning |
| `capacity-baseline.md` | 加“结论先行”引用块 | 长页给一句要点摘录 |
| `observability.md` | 观测入口改表格；storage 命令改代码块；规则文件改无序列表；`::: warning` `/healthz` 不返回明细；`::: tip` monitoring profile 一键启动；修正断裂列表 | 命令可复制、并列信息表格化、重点容器化 |
| `llm-call-capability.md` | 开头加结论引用块；密钥必填 `::: warning`；配额段重排 | 读者不看会踩坑的约束前置 |
| `cli.md` | `::: info` 区分 `noj-cli` 与 `/app/bin/noj`；命令模板与常用子命令拆开；`::: tip` 更短等价写法（含 `--install-dir` 提醒） | 两个同名 CLI 极易混；缩短长命令 |
| `judge-workers.md` | 导语引用块；首次配置必填项改列表；`--redis-mode local` `::: tip`；并发/CPU 改表格；镜像规则改列表；日志排查 `::: details` 折叠 | 长页组织、可选细节折叠 |
| `admin-guide.md` | RBAC 角色加 `<Badge>`；黑名单 `::: warning` 可信代理；轮播解耦改 `::: info`；系统设置分区表 | 状态/类型行内标记；易错点提示 |
| `legal-compliance.md` | 留存表补“配置键/取值”列并区分 bootstrap vs 常量 | 消除“可配置”误解 |
| `production-secrets.md` | 部署前检查改两段编号命令；`::: warning` 轮换前必备、短暂不可用；JWT/TFA `::: danger` | 高危不可逆操作显式警示 |
| `email-delivery.md` | 一句话导语；fixture 入口 `::: danger` | 危险入口前置警告 |

**容器统计**：改前本组仅 `admin-guide.md` 有 2 个 `:::`（1 组）；
改后共 **40** 个 `:::` 标记（20 组容器），分布：
`production-deploy` 6、`admin-guide` 3、`production-secrets` 3、`observability` 2、
`judge-workers` 2、`cli` 2、`llm-call-capability` 1、`email-delivery` 1。
新增 1 处 `<Badge>`（admin-guide 的 RBAC 角色），其余页面未强加。

## 视觉评价

用本地 dev server（`http://localhost:5173`）+ 无头 Chrome 截图，改前/before 与改后/after
各截代表页，落盘 `/tmp/opencode/audit-shots/operators/`：

- `before_*` / `after_operators_production-deploy.png`
- `before_*` / `after_operators_observability.png`
- `before_*` / `after_operators_judge-workers.png`
- `before_*` / `after_operators_cli.png`
- `after_operators_production-secrets.png`、`after_operators_index.png`、
  `after_operators_admin-guide.png`、`after_operators_legal-compliance.png`、
  `final_operators_llm-call-capability.png`、`final_operators_email-delivery.png`

人类视角评价：

1. **层次更清晰**：`production-deploy` 与 `observability` 原本是“一堵文字墙”——
   段落密集、并列信息塞在自然段里。改为表格 + 编号步骤后，右侧目录（本页目录）与
   正文的对应关系更好，扫读时能先定位“安装 / 日常运维 / 升级与回滚”。
2. **容器使用得当、未滥用**：`production-secrets` 的“轮换前必备”与 JWT/TFA 的
   `danger` 用红/黄块把不可逆风险拉出正文；`observability` 的 `/healthz` 警告块
   短小，不喧宾夺主。每页 1–5 个，符合规范。
3. **命令可复制性提升**：`observability` 的 storage 命令从跨行行内代码改为独立
   代码块；`cli.md` 把 `<子命令>` 模板与“常用子命令”分离，减少了长命令淹没正文。
4. **仍需注意**：`judge-workers` 的首次配置表格我曾试改表格，因“旗标”列窄导致
   `--socket-path` 换行难看，已回退为列表——说明**窄列 + 长标识符**在本主题下应优先
   用列表而非表格。
5. 渲染整体正常：所有 `:::` 容器成对闭合（脚本校验 20 组均平衡），`<Badge>` 正常
   渲染，代码块高亮无误，未出现裸 `:::` 或未渲染 Markdown。

## 遗留问题 / 建议

以下涉及**范围外文件**（`deploy/**`、脚本）或需人拍板，未自行修改：

1. **`deploy/monitoring/noj-alerts.yml` 注释仍指向已弃用脚本**：
   `NojBackupStale`/`NojBackupVeryStale`/`NojBackupMetricMissing` 组注释写
   “指标由 backup.sh / restore-drill.sh 写入”，`NojRestoreDrillStale` 的 description
   写“请执行 scripts/deploy/restore-drill.sh”。实际指标写入方已是 `noj-cli`
   （`noj-cli/src/prod/backup/metrics.ts`、`prod/drill/report.ts`），那两个脚本已加弃用闸门。
   建议（未改，需人确认）：更新告警文件注释与 description。
2. **`deploy/monitoring/README.md` §4** 仍以 `scripts/deploy/backup.sh create` /
   `restore-drill.sh` 为写入方描述，与 `noj-cli` 重写后的实现漂移。
   建议（未改，需人确认）：同步为 `noj-cli backup create` / `noj-cli backup drill`。
3. **`observability.md` §社区搜索性能**：原文“迁移 0017 已负责启用 `pg_trgm` 扩展”，
   实测 `0070_unusual_starfox.sql` 也执行了 `CREATE EXTENSION IF NOT EXISTS pg_trgm`
   （`noj-core/drizzle/0070_unusual_starfox.sql:2`）。不影响结论（扩展确实已启用），
   但“0017 负责”的措辞可能让人以为只此一处。**已修正**（2026-09-24 复核补修）：
   改为“迁移 0017 与 0070 先后启用”。
4. **`capacity-baseline.md`** 未提及 `JUDGE_MAX_CONCURRENT_JUDGES` 与
   `JUDGE_CPU_LIMIT_MILLICORES` 作为必录字段；报告模板已有 `judge_concurrency`，
   但缺 CPU 上限。**已修正**（2026-09-24 复核补修）：模板补 `judge_cpu_limit_millicores=`。
5. **`llm-call-capability.md` §4** 提到配额可“按用户、全局、题目、用户×题目”维护，
   但 `noj-ui` 无配额维护页面，运营者只能调接口或依赖网关 `.env` 兜底默认值；
   文档已如实改为接口表述，但**产品层面**是否补一个配额管理页属跨模块决策。
   建议（未改，需人确认）：评估是否在管理端补配额编辑界面。
6. **`production-deploy.md` §5.1** 演练依赖 `noj-evaluator-python` /
   `noj-solution-python` 镜像，文档未说明如何在演练前拉取/预热这些镜像。
   建议（未改，需人确认）：补一句镜像预热说明（或确认 drill 内部会拉取）。
