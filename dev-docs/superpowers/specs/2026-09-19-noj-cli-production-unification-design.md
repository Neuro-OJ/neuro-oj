# 无人值守目标设计：noj-cli 生产运维统一与文档漂移治理（#510 / #513 / #515 / #516 / #518）

> ⚠️ **本 spec 已被取代（2026-09-19）**：新要求改为**纯 TS 重写、不保留任何 bash 实现、移除 setup.sh/install.sh、直接采用 Cliffy**，其自举边界与渐进迁移前提已不成立。详见 `2026-09-19-noj-cli-pure-ts-rewrite-design.md`。本文件保留作为历史决策记录（其已确认的 drill 语义、.nojbackup 标准、#510 治理结论已被新 spec 吸收）。

Status: approved
日期：2026-09-19
执行者：AI Agent（无人值守自主执行）
批准人：项目所有者（人在回路讨论后批准）
基线：`b3e99199e7cc95361b6049c08681f974557f8611`（= `main@origin`，2026-09-19 会话中刷新后确认）

> **基线修正记录（实测）**：会话开始时 `main@origin` 为 `563de7ff`。会话期间有两个 PR 合入，main 前进到 `b3e99199`：
> 1. `851def8680a0` — `test(core): 移除 jwt 测试静默跳过守卫，修复 Root Gates 基线门禁`（#539，MERGED）
> 2. `b3e99199e7cc` — `fix(root): 修复LLM额度重复扣算与Provider更新失败`（#524，MERGED）
>
> 即 `563de7ff → 851def86 → b3e99199`。本设计以刷新后的 `b3e99199` 为基线（`563de7ff` 现为其祖先）；功能分支即从此处 `jj new` 展开。

**关联 spec**：`2026-09-19-noj-cli-ui-modernization-and-cliffy-design.md`（界面现代化与 Cliffy 迁移）。其**阶段二依赖本 spec 的 D4**（删除 bash 透传），两者改同一批文件，必须串行。

---

## 1. 背景：五个 issue 的真实状态（实测）

本次调查发现一个必须先说清的事实：**#518 / #515 / #516 的代码已经合入 main，issue 却仍 OPEN。**

| PR | 提交 | 对应 issue | 实际状态 |
| --- | --- | --- | --- |
| #527 | `refactor(root): profile 分级、deploy+maintain 合并为 stack、Tier 3 容器包装` | #518 | 主要能力已落地 |
| #533 | `feat(root): 统一备份模型（识别 legacy、list/prune、默认 dry-run）` | #515 | 仅落地 P6 子集 |
| #534 | `feat(root): backup drill 重定义为真实恢复演练` | #516 | 演练已接入 |

它们保持 OPEN 的原因写在 Agent Note 里：**PR 刻意不使用 `Closes`，并明确记录「范围内未完成」**。

### 1.1 已定位的真实缺口

| issue | 缺口 | 证据 |
| --- | --- | --- |
| #515 | `verify --deep` **完全未实现** | 全仓 `rg Deep` 零命中，仅 `cli.ts:933` 一句「由 #515 提供」的注释 |
| #515 | `backup create` 单文件 + 整包加密、`restore --dry-run`、`backup` 顶层唯一入口、`schedule` 双 profile | `2026-09-17-backup-unified-list-prune.md` 的「范围内未完成」清单 |
| #516 | 文档与已合并现实**直接矛盾** | `production-deploy.md:163,166` 仍称 `backup drill` 只做文件级校验 |
| #518 | `noj-cli/README.md` 无 stack / profile / Tier 3 字样 | `rg` 零命中 |
| 全部三项 | **仓库无任何 CHANGELOG 文件**，而三个 issue 的验收都要求 changelog | `find -iname 'CHANGELOG*'` 仅命中 node_modules |
| #513 | 唯一零开工项；已获 Owner 批准移除 | issue 评论：「可以，移除吧 / 目前确实没啥用」 |
| #510 | 文档漂移，需以代码为第一事实源校准 `ROADMAP.md` / `AGENTS.md`；并移除「多语言评测」 | issue #510（bug）；漂移证据见 §1.4 |

### 1.2 #515 与 #516 的格式矛盾（本设计的核心问题）

#515 要求生产备份统一为**单文件 `.nojbackup`**；而 #516 已合并的实现**显式拒绝单文件**（`drill.ts:168`，退出码 2），理由经实测：

| 条目 | 生产目录快照（`backup.sh create`） | 单文件 `.nojbackup`（`backupCreate`） |
| --- | --- | --- |
| `postgres.dump` | `pg_dump -Fc` **原始二进制** | base64 **文本** |
| `env.prod.gpg` | GPG 加密的生产环境文件 | 不存在（环境在 `noj-secrets.json`） |
| `postgres.restore-list` | `pg_restore --list` 结构清单 | 不存在 |
| `redis.rdb` | `redis-cli --rdb` 原始二进制 | base64 文本 |

`drill.ts` 的注释指出：把 base64 文本喂给 `pg_restore` 会**恢复出垃圾数据** —— 比报错更糟的静默错误。**因此 `drill` 拒绝单文件是正确的防御，不能削弱。**

**结论：`drill` 与现有单文件格式不可调和；但 #515 要的是「单文件 + 整包加密 + 可搬迁」，与 payload 是原始二进制还是 base64 正交。** 解是**单文件容器 + `prod-raw` payload 布局**。

### 1.3 环境能力（实测）

- Docker 29.8.0 / Compose 5.5.1 可用；215G 磁盘可用
- `postgres:16-alpine` 在本地（`pg_restore 16.14` 可用），`noj-evaluator-python` 在本地；`noj-solution-python` **不在**
- `/opt/neuro-oj` 生产安装目录**不存在** → 真演练无法在本机端到端取证，只能靠 CI（见 §5）
- 版本控制：**jj（Jujutsu）仓库**，本地操作一律用 jj，不用 git。远端仍是标准 Git（GitHub 看到普通分支/提交）

### 1.4 #510 文档漂移实测（以代码为第一事实源）

`ROADMAP.md` 共 16 项未勾选，逐条用代码核实后分为三类：

**A. 已实现却标未完成（应勾选）**

| ROADMAP 行 | 声称 | 代码事实 |
| --- | --- | --- |
| `:90` | 代码相似度检测未完成 | `noj-core/src/domains/contest/services/contest-similarity.ts` **已存在**（1315 行，在规模棘轮基线内） |
| `:91` | 成绩单 CSV/JSON 导出未完成 | `noj-core/src/domains/admin/routes/contest.ts:665,762` 已实现（`csvCell`、`/ranking-snapshots/latest.csv`） |

**B. 应移除（决策性不做项）**

| 位置 | 漂移 |
| --- | --- |
| `ROADMAP.md:57,73` | 「多语言：Python/C++/Java/JavaScript」「多语言：C++/Java/Node.js」—— 按 #510 要求移除 |
| `noj-ui/pages/about.vue:324` | 称「更多语言由管理员配置评测镜像后在管理后台启用」，与 `noj-docs/docs/mechanisms/runtimes.md` 的**决策性不做**声明矛盾；实际 UI 仅 `languages = [{ value: 'python3' }]`（`EditorWorkspace.vue:189`） |

> `AGENTS.md` **无**多语言漂移（实测 `rg '多语言|C\+\+|Java|JavaScript'` 仅命中 `:117` 的 Node.js 技术栈描述）。现役文档中多语言漂移只存在于上表两处。

**C. 确实未实现（保留，但需补证据链接）**

`SPJ`(`:74`)、交互题(`:75`)、容器预热(`:76`)、A/B 榜(`:93`)、IOAI/NOAI 赛制(`:94`)、赛后复盘(`:101`)、公开/私有榜(`:103`)、Judge 水平扩展(`:111`)、压力测试(`:118`)、评测插件机制(`:119`)、IOAI/NOAI 题目包导入(`:120`)、GPU 执行器(`:121`) —— 实测 `rg` 无对应实现。

**D. 与本次删除冲突（顺序依赖）**

`ROADMAP.md:113` 记录「数据库备份与迁移策略（`scripts/deploy/backup.sh` + `restore-drill.sh`）」——**正是本设计 D6 要删除的文件**。

`AGENTS.md` 漂移：`:144-146` 与 `:351` 仍使用已被 #518 合并为 `stack` 的 `deploy init/up/status`。

> **由此得出硬顺序约束**：文档校准必须在**代码定稿之后**执行。若先校准 #510 再删脚本，`ROADMAP.md:113` 会二次失效，产生新的「文档指向不存在脚本」漂移。故 #510 **合并进 D6**，按「代码定稿 → 文档校准」一次完成。

---

## 2. 目标与边界

### 2.1 目标

以 `noj-cli`（`deno compile` 产出的自包含二进制）为**唯一实现**，把生产运维统一到**单文件容器 `.nojbackup`** 标准上；删除被取代的脚本实现；收口 #515/#516/#518 的剩余验收项并执行 #513 的 `noj` 入口移除；并以代码为第一事实源校准 `ROADMAP.md` / `AGENTS.md` 等现役文档的漂移、移除「多语言评测」（#510）。

### 2.2 关键决策（人在回路确认）

| 决策 | 结论 |
| --- | --- |
| 统一程度 | **统一实现**，不只是统一格式：脚本侧维护功能全部改由 noj-cli 实现 |
| 范围 | **含 `deploy.sh` 生命周期**（最大范围） |
| 历史兼容 | **不做**。当前处于快速迭代阶段，无上线服务 → 删 legacy 识别、别名过渡、双 payload |
| bash 保留区 | **仅 `setup.sh` → `install.sh` 自举边界**，其余归 noj-cli |
| 验收口径 | **CI 是金标准** |
| 交付模型 | **功能分支 + 一个 Draft PR**，评审通过后合并进 main；D0→D7 的提交在同一分支上累积，main 在合并前不动 |
| 预算 | 按顺序持续执行，能做多少做多少，如实记录；未达标降级为「进行中」 |
| 完成口径 | 完整性 > 数量；**不半成品提交、不假装全部完成** |
| #510 纳入方式 | **合并进 D6**，作为同一交付阶段（避免两轮产生新漂移） |
| 多语言处置 | **移除**（含 `ROADMAP.md` 与 `about.vue` 的用户可见错误承诺） |
| 确实未实现的 ROADMAP 项 | **保留**，但逐条补证据链接（代码位置或 issue 号），防止再次漂移 |

### 2.3 自举边界（不可消除的结构约束）

`setup.sh`(35 行) → `install.sh`(737 行) 必须在 **CLI 存在之前**运行：`install.sh:535` 的 `download_cli()` 从 GitHub Release 下载 `noj-cli-linux-amd64` 并校验 SHA-256。**CLI 不能用来安装自己。**

保留：源码归档下载、CLI 二进制下载 + SHA-256 校验、归档校验、`install-env`。
改动：其调用的**下游脚本**全部改为调 `noj-cli`。

### 2.4 明确不做（YAGNI）

- ❌ 删除 `setup.sh` / `install.sh` 的 bootstrap 职责
- ❌ 历史兼容（legacy `snapshot-*` 识别、`deploy`/`maintain`/`doctor` 别名过渡、双 payload 分派）
- ❌ 增量备份 / PostgreSQL PITR（架构事实：需外部 WAL 归档）
- ❌ 异地 / 对象存储自动上传（属部署架构决策）
- ❌ 改 `_journal.json`、手改 `deno.lock` / `Cargo.lock`
- ❌ 在功能分支合并前改动 main；以及触碰与 #510/#513/#515/#516/#518 无关的改动
- ❌ 校准历史归档文档（`dev-docs/superpowers/plans/`、`openspec/changes/` 等）—— #510 明确排除

---

## 3. 架构

### 3.1 单文件容器格式（`.nojbackup`）

```text
snapshot-<ts>.nojbackup
└─ gpg(AES256, /etc/noj/backup-passphrase)     ← 整包加密，#515 P2 根治
   └─ tar.zst
      ├─ manifest.json          schema_version / payload_layout / created_at / sha256
      ├─ postgres.dump          pg_dump -Fc 原始二进制
      ├─ postgres-globals.sql
      ├─ redis.rdb              redis-cli --rdb 原始二进制
      ├─ minio/…
      ├─ env.prod.gpg
      ├─ migration-status.txt
      ├─ sha256sums.txt
      └─ SUCCESS
```

`payload_layout: "prod-raw"` 是**唯一形态**（无历史兼容 = 不需要分派）。布局与 `backup.sh create` 逐文件一致，使 `restore-drill.sh` 的消费契约继续成立。

**实现要点（最易做错处）**：现有 `backup_driver.ts:114` 注释写明 base64 是因为数据经 **stdout 字符串**传输，二进制会损坏。`prod-raw` 必须走**文件重定向**（`docker compose exec -T … > file`，与 `backup.sh:246` 相同），不得沿用 stdout 字符串捕获。否则引入静默损坏。

### 3.2 drill 的消费路径

```text
noj-cli backup drill <file.nojbackup>
  → 校验 payload_layout == "prod-raw"
  → 解包到临时目录
  → 交给隔离演练编排（独立 Compose 项目 / 独立子网 / 不映射宿主端口）
  → 业务验收（登录 / 题目读取 / 可选附件+真实评测）
  → 清理（含失败路径）；--keep 保留
```

### 3.3 模块边界（新域 `noj-cli/src/prod/`）

| 模块 | 职责 | 来源 |
| --- | --- | --- |
| `prod/compose.ts` | compose 调用、env 读取、镜像 cosign 验签 | `deploy.sh` 的 `run_compose` / `verify_image_signatures` |
| `prod/lifecycle.ts` | install/start/stop/restart/status/logs/uninstall/update | `deploy.sh` |
| `prod/config.ts` | 配置校验、交互向导、口令生成 | `deploy.sh` + 复用既有 `init/wizard.ts` |
| `prod/backup/` | create/verify/restore/list/prune/extract + **prod-raw driver** | 重写 `backup.sh` |
| `prod/drill/` | 演练编排 + 业务验收 | 移植 `restore-drill.sh` + `restore-drill-verify.ts` |
| `prod/schedule.ts` | crontab 标记区块管理 | `backup-schedule.sh` |

**删除**：`deploy.sh`、`backup.sh`、`backup-schedule.sh`、`restore-drill.sh`、`production.sh`、根 `noj`、5 个对应 `test-*.sh`。

**业务验收编译进 CLI**：`restore-drill-verify.ts` 原在隔离环境内经 `denoland/deno` 容器执行（`restore-drill.sh:288` 固定 digest）。迁入后由 CLI 直接发起 HTTP 验收，顺带消掉一个镜像依赖。

### 3.4 不可回归的对外契约

1. **三个监控指标名**（被 `deploy/monitoring/noj-alerts.yml` 引用）
   - `noj_backup_last_success_unix_time`
   - `noj_backup_snapshot_bytes`
   - `noj_restore_drill_last_success_unix_time`
2. `docker-compose.prod.yml` / `.env.prod` 语义不变
3. `bin/noj-cli` 的 PATH 注册与 `--files-only` 自更新路径

---

## 4. 交付物与执行顺序

严格串行；**每步独立可验收，分支在每个 checkpoint 均保持可合并状态**。删除旧实现必须是末尾的独立提交。

落地方式（jj）：从 `main@origin`（`b3e99199`）起一条功能分支，每个 D 项打一个 jj change 并 `jj describe` 中文提交信息；全部完成后 `jj bookmark create` + `jj git push` 开 Draft PR。**绝不在合并前推进 main。**

| # | 交付物 | 内容 |
| --- | --- | --- |
| D0 | 基线快照 | 记录当前绿基线（`323 passed`）与冻结 SHA；后续所有失败以此为对照 |
| D1 | 单文件容器 + prod-raw | `create` 产出加密单文件；prod-raw driver；整包加密；口令自动生成；指标契约 |
| D2 | 命令面收口 | `list` / `prune`（默认 dry-run）/ `restore --dry-run` / `verify --deep`；顶层 `backup` 唯一入口 |
| D3 | drill 接入 | 接受 prod-raw 单文件；`--skip-judge`/`--subnet`/`--keep`/`--json`；退出码语义 |
| D3b | **real-drill CI job** | 用合成快照在 CI 真实跑一次 drill（独立交付物，最高风险） |
| D4 | 生命周期迁移 | `deploy.sh` → CLI；能力对照矩阵逐项断言；交互/非交互/cosign |
| D5 | 调度迁移 | `backup-schedule.sh` → CLI；crontab 标记区块幂等 |
| D6 | 删除 + 文档收口 | 删旧实现；**#510 文档校准**；文档纠错；新建 CHANGELOG；openspec 修正 |
| D7 | 证据与自审 | 验收证据文档 + 进度日志 + 待人工 review 清单 + Draft PR |

### 4.1 D6 内部顺序（#510 的硬约束）

D6 必须严格按以下顺序，否则会产生新漂移：

```text
1. 删旧实现（deploy.sh / backup.sh / backup-schedule.sh / restore-drill.sh / production.sh / 根 noj / 5 个 test-*.sh）
2. 更新 scripts/check-ci.ts 与 noj-cli/deno.json 的引用
3. #510 文档校准（此时才以「已删除」为准）
     3a. ROADMAP.md：A 类勾选、B 类移除多语言、C 类补证据链接、D 类改用新命令
     3b. AGENTS.md：deploy init/up/status → stack；移除多语言相关表述
     3c. about.vue:324 移除「可配置更多语言」的错误承诺
4. 其余文档纠错（production-deploy.md / cli.md / noj-cli/README.md / scripts/README.md）
5. 新建 CHANGELOG
6. openspec/changes/add-noj-cli/tasks.md:9 矛盾修正
```

### 4.2 real-drill CI job 的额外约束（实测发现）

`docker-compose.prod.yml` 的镜像全部是**已发布的 ghcr 镜像**（`docker-compose.prod.yml:79` 等），CI 无可用发布版本。因此 D3b 必须：

1. 本地构建镜像（复用 e2e 既有 `--build` 模式）
2. 用 **CI override** 把 `noj-server` 等重映射到本地构建产物
3. 先 migrate + 种数据（管理员/题目），再 `backup create`，再 `drill`
4. `drill` 不带 `--skip-judge` 时会查 `judge_images` 白名单（`restore-drill.sh:467-477`）→ 需种该数据或用 `--skip-judge`

---

## 5. 验收标准（CI 金标准）

### L0 · 全局门禁

| 门禁 | 命令 | CI 落点 |
| --- | --- | --- |
| CLI 静态 + 单测 | `cd noj-cli && deno task check && deno task test` | `ci.yml` → `production-cli` |
| 生产集成 | `deno task test:production` | 同上 |
| 仓库级门禁 | `deno run -A scripts/check-ci.ts` | `ci.yml` → `root-gates` |
| main 可部署 | 每个 commit 后 `test:production` 仍绿 | 执行顺序约束 |
| 签名 / 规范 | 中文 Conventional Commits + GPG；Agent Note 格式校验 | `root-gates` |

### D1 · 单文件容器与整包加密（#515 P1/P2/P3）

- [ ] `backup create` 产出**单个** `.nojbackup`；`payload_layout == "prod-raw"`
- [ ] **无口令无法读取包内任何内容**（含 `postgres.dump`）—— P2 回归断言
- [ ] `--no-encrypt` 显式降级并**打印警告**
- [ ] 口令文件缺失时**自动生成**到 `/etc/noj/backup-passphrase`，权限 `600`；已存在则复用
- [ ] 口令文件权限非 `600`/`400` 时**拒绝执行**并给可操作提示
- [ ] `postgres.dump` 可被 `pg_restore --list` 解析（**防 base64/stdout 静默损坏**）
- [ ] 三个监控指标名**逐字**写出

### D2 · 命令面收口（#515 P1/P6/P8）

- [ ] `backup` 为唯一顶层入口（无 `maintain backup` 第二入口）
- [ ] `backup list` 显示时间/大小/版本/迁移版本，**无需解包**
- [ ] `backup prune` **默认 dry-run**，`--confirm` 才删；`--keep N` / `--older-than` 生效
- [ ] `backup restore --dry-run` 打印将覆盖范围且**无副作用**（mtime 断言）
- [ ] `verify` 与 `verify --deep` 分档，help 写明差异
- [ ] `--deep` 覆盖结构校验（`pg_restore --list`、Redis/MinIO 存在性）
- [ ] manifest **不含占位 `rpo`/`rto`** 字符串

### D3 · drill 真演练（#516）

- [ ] `drill` 接受 `prod-raw` 单文件
- [ ] `--project-name` **拒绝包含 `prod`**（硬校验）
- [ ] `--skip-judge` / `--subnet` / `--keep` / `--json` 全部生效
- [ ] **超 RPO**（快照过旧）→ 演练失败 + 说明原因
- [ ] **超 RTO**（恢复过慢）→ 演练失败 + 说明原因
- [ ] 退出码：`0` 通过 / `1` 演练失败（含 RPO/RTO 超限）/ `2` 用法与资源前置错误
- [ ] 失败路径**也**清理隔离资源；`--keep` 保留并打印查看方式
- [ ] 演练**不映射任何宿主机端口**；使用独立子网
- [ ] 演练**不触碰生产数据卷**
- [ ] 演练失败时报告包含**具体失败的步骤**，而非只有退出码
- [ ] `--json` 结构稳定：`pass`/`snapshot`/`restored_at`/`rpo_hours`/`rto_minutes`/`steps[]`
- [ ] `backup drill --help` 明确「分钟级、耗 Docker」，且**不产生任何副作用**

### D3b · real-drill CI job

- [ ] CI 中用合成快照真实跑通：起隔离项目 → 实恢复 → **HTTP 业务验收（登录 + 题目读取）**
- [ ] 失败时上传诊断报告为 artifact
- [ ] job 耗时与资源在 runner 上限内（超时则降级，见 §6）

### D4 · 生命周期迁移（`deploy.sh` → CLI）

- [ ] **能力对照矩阵**逐项覆盖并各有一条断言：`install` / `start` / `stop` / `restart` / `status` / `logs` / `uninstall` / `update` / `verify` / `config-check`
- [ ] 交互式输入可透传（`/dev/tty` 语义等价）；`--non-interactive` 行为一致
- [ ] 镜像 **cosign 验签**保留
- [ ] `--dry-run` 不产生副作用
- [ ] `docker-compose.prod.yml` / `.env.prod` 语义不变

### D5 · 调度迁移

- [ ] crontab **只动自己的标记区块**，不覆盖他人任务；重复 install 幂等；remove 只删自己的区块

### D6 · 删除旧实现与文档收口（#510 + #513 + 统一）

- [ ] 删除 `deploy.sh` / `backup.sh` / `backup-schedule.sh` / `restore-drill.sh` / `production.sh` / 根 `noj` / 对应 5 个 `test-*.sh`
- [ ] `scripts/check-ci.ts:69-71` 不再引用已删脚本（改为新测试入口）
- [ ] `noj-cli/deno.json` 的 `test:production` 更新（保留 `test-install.sh`，它测保留的 `install.sh`）
- [ ] **`rg` 残留引用清单为空的实测输出**
- [ ] `openspec/changes/add-noj-cli/tasks.md:9` 的矛盾已修正
- [ ] 文档纠错：`production-deploy.md:163,166`（drill 已非文件校验）、`cli.md:23`（不再手写 compose）、`noj-cli/README.md`（补 stack/profile/Tier 3）、`scripts/README.md`
- [ ] **新建 CHANGELOG**（#515/#516/#518 三条验收共同要求）

**#510 文档漂移治理（以代码为第一事实源）**

- [ ] `ROADMAP.md` A 类：代码相似度检测、成绩单 CSV/JSON 导出**勾选**（附代码位置）
- [ ] `ROADMAP.md` B 类：**移除全部多语言条目**（`:57`、`:73`）
- [ ] `ROADMAP.md` C 类：12 项确实未实现者**保留**，且逐条补证据链接（代码位置或 issue 号）
- [ ] `ROADMAP.md:113` D 类：`backup.sh + restore-drill.sh` 改为新的 CLI 实现（文件已删）
- [ ] `AGENTS.md:144-146,351` 的 `deploy init/up/status` 改为 `stack`
- [ ] `AGENTS.md` **无需**移除多语言表述（实测：`rg '多语言|C\+\+|Java|JavaScript'` 仅命中 `:117` 的 Node.js 技术栈描述，与评测语言无关）；多语言漂移仅在 `ROADMAP.md` 与 `about.vue`
- [ ] `about.vue:324` 移除「更多语言由管理员配置评测镜像后启用」的错误承诺
- [ ] **归档文档不动**（`dev-docs/superpowers/plans/`、`openspec/changes/`）—— #510 明确排除
- [ ] 校准后 `rg` 复核：**无指向已删文件或已移除能力的残留引用**

**工程**

- [ ] 非平凡变更补 Agent Note；提交为中文 Conventional Commits + GPG 签名

### D7 · 证据完整性

- [ ] 验收证据文档：逐项交付物 + CI 结论 + 验证命令与实测输出
- [ ] 工作日志：时间线 + 每项状态 + 问题与处置
- [ ] 待人工 review 清单
- [ ] 一个 Draft PR 链接
- [ ] **#510 校准清单**：逐条列出「原文 → 校准后 → 依据（代码位置）」

---

## 6. 风险与处置

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 一次删光脚本 → main 不可部署 | 高 | 严格「先落地 → CI 绿 → 再删」；删脚本为末尾独立提交 |
| base64/stdout **静默**损坏二进制 | 高（静默） | prod-raw 强制文件重定向；断言 `pg_restore --list` 可解析 |
| 监控指标名被改动 → 告警静默失效 | 高（静默） | D1 逐字断言三个指标名；`NojBackupMetricMissing` 48h 才响，必须测试锁死 |
| real-drill job 不可行或超时 | 中 | D3b 独立交付；不可行时**降级为 fake-docker + 报告明确标注「真演练未取证」**（诚实降级，不假装） |
| `deploy.sh` 交互/宝塔/cosign 行为漂移 | 中 | D4 能力对照矩阵逐项断言；`test-install.sh` 保留复用 |
| `--files-only` 自更新路径失效 | 中 | 保留 `install.sh`（`cp -a` 整目录，不依赖具体文件）；升级路径构造一次实测 |
| 范围过大做不完 | 高 | 完整性 > 数量；未达标降级为「进行中」写入报告 |
| 无人值守卡死 | 中 | 同一失败**尝试上限 3 次**，超限记录根因并跳过；每 checkpoint 写进度日志保证可续 |
| 误伤 main 上既有改动 | 中 | 从 `main@origin` 起独立功能分支（jj change），不 `jj edit` 已发布提交 |
| **文档校准顺序颠倒 → 新漂移** | 中 | 严格按 §4.1：删代码**之后**才校准文档；`ROADMAP.md:113` 是典型受害点 |
| #510 校准引入**新的错误断言** | 中 | A/C 类逐条附代码位置；C 类保留原状而非虚构进度；校准后 `rg` 复核 |

---

## 7. 交付证据要求

执行结束时必须产出：

1. **验收证据文档**（`dev-docs/unattended/`）：逐项交付物、对应提交/PR、CI 结论、验证命令与实测输出
2. **工作日志**：时间线、每项状态（完成/进行中/未开始）、问题与处置
3. **待人工 review 清单**：需 Owner 决策或复验的事项（尤其真演练取证边界）
4. **PR 清单**：一个 Draft PR 链接与状态

---

## 8. 与既有工作的关系

- **与已合并的 #527 / #533 / #534**：本目标是它们的**收口与统一**，不推翻已确认的决策（profile 探测失败必须报错、Tier 3 容器包装、drill = 真演练）；但**反转两处**：(a) legacy 兼容删除（因无上线服务），(b) 单文件成为生产唯一产物形态。
- **与 #517（ergonomics）**：已合并，其结论（`--help` 只读、退出码分层）是本设计的前提。
- **与 #514（题目包 CLI）**：已合并；`problem` 命名统一已落地，本设计不动。
- **与界面现代化 spec（2026-09-19-noj-cli-ui-modernization-and-cliffy-design.md）**：该 spec 的**阶段二（Cliffy 迁移）依赖本 spec 的 D4**（删除 bash 透传）。两者都改 `cli.ts`，必须**串行**：本 spec 先落地 D4，再执行 Cliffy 迁移。该 spec 的 S2（参数 schema 显式化）与本 spec 的 D4 结构相邻，实施时需协调顺序避免冲突。
- **与 #510（文档漂移治理）**：**合并进 D6**。两者在 `AGENTS.md`（`deploy`→`stack`）与 `ROADMAP.md:113`（记录将被删除的脚本）两处直接重叠；分开做会产生二次漂移。沿用既有约定（`.agents/notes/.../2026-09-12-review-doc-staleness-and-core-docs-sync.md`）：**评审/审计类时点快照不回溯修改结论**，只校准 ROADMAP/AGENTS 等现役文档。
- **与上一次无人值守 spec（2026-09-11）**：沿用其证据纪律（实测优先、不假装完成、诚实降级）与 Draft PR 交付模型。区别是本次为**单一 Draft PR**（上一轮为多条 stacked PR）。
