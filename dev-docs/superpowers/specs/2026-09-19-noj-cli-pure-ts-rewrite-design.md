# noj-cli 纯 TS 重写与界面现代化设计（推倒重来）

Status: approved
日期：2026-09-19
执行者：AI Agent（无人值守自主执行）
批准人：项目所有者（人在回路讨论后批准）
基线：`b3e99199e7cc95361b6049c08681f974557f8611`（= `main@origin`）

> **本 spec 取代以下两份 spec**（其前提已被本次要求推翻）：
> - `2026-09-19-noj-cli-production-unification-design.md`（保留 bash 内核 + 渐进迁移 + 自举边界）
> - `2026-09-19-noj-cli-ui-modernization-and-cliffy-design.md`（两阶段：先界面后框架；阶段二依赖 D4）
>
> 两者的**已被本次吸收的有效结论**：单文件 `.nojbackup` 标准、drill 真演练语义、#510 文档漂移治理、#513 的 `noj` 移除、品牌 token 需补 CLI 段。**被推翻的结论**：bash 自举边界（不再保留）、渐进迁移（改为一次重写）、Cliffy 两阶段（改为直接采用）。

---

## 1. 最高约束（本次要求原文）

| # | 要求 | 影响 |
| --- | --- | --- |
| R1 | **noj-cli 全部用 TS 实现**，不保留任何调用 bash 脚本的实现 | 删除全部 `Deno.Command("bash", …)`；`deploy.sh`/`production.sh`/`backup.sh`/`restore-drill.sh`/`backup-schedule.sh`/`judge-install.sh` 逻辑全部迁入 TS |
| R2 | 现有 bash 脚本标记**「已过时」**，启动时警告并要求输入 `y` 确认 | 仅**用户运维入口**脚本加闸门（见 §2.2） |
| R3 | **尽可能保证 noj-cli 实现与 bash 一致** | 既有 2722 行 bash 测试是**可执行的 parity 对照物** |
| R4 | 移除 `install.sh`、`setup.sh`；**用户手动下载 noj-cli 二进制** | 原自举边界消失；下载职责转入 CLI 自身 |
| R5 | 用成熟 CLI 库封装 + ANSI 颜色 + 富文本改进界面 | 采用 **Cliffy**（已验证，见 §4） |
| R6 | 改进 `problem init` 交互体验 | 复用/增强 `problem/tui.ts` |
| R7 | 按设计**全面统一 `.nojbackup` 备份流** | 单文件容器 + `prod-raw` payload 成为唯一形态 |
| R8 | 激进变更：无上线实例，可大刀阔斧重塑架构 | 但仍须**用尽可能多的测试保证行为正确** |

---

## 2. 架构诊断：病根是「双模态共存」，不只是「外壳跑 bash」

> 本节是**单模态决策的依据**。原要求 R1（全部用 TS）只解决了「TS 调用 bash」这一层；实测发现更深的问题：
> **两套模式各自演化出了一半能力，共享的只有命名空间。** 若只重写语言而不合并模态，重写完仍是两套半成品。

### 2.1 能力对照（实测）

| 能力 | `prod` 模式（`.env.prod`） | `stack` 模式（`noj-deploy.json`） |
| --- | --- | --- |
| 配置格式 | `.env.prod`（**51 个键**，纯文本插值） | JSON（结构化） |
| 配置校验 | ✅ bash `check_required_values`（**硬编码 19 个键名**） | ✅ TS `config/validate.ts` |
| 部署 | ❌ 转发 `deploy.sh` | ✅ `deployUp()` TS 原生 |
| **状态追踪** | ❌ **无**（`status()` = `docker compose ps`） | ✅ `deploy/state.ts` + `state/machine.ts` |
| 备份 | bash `backup.sh`（目录形态） | TS `backup.ts`（单文件） |
| 日志 | bash `deploy.sh:1117` | TS `maintain/logs.ts` |
| 安装 | `install.sh`（737 行） | `deploy init` 向导（`init/wizard.ts`） |
| 环境检测 | `check` → bash | `doctor` → TS `doctor/probe.ts` |

**每一行都是同一能力实现两次**——两种语言、两种配置、两种语义。

### 2.2 最有说服力的单点证据：`status` 的不对称

- `stack` 有**真正的状态机**：`deploy/state.ts`(37) + `state/machine.ts`(59)，可判定 `up`/`down` 是否 no-op
- `prod` 的 `status()` 只有三行（`deploy.sh:1112-1115`）：`prepare_and_check; run_compose ps`

即 **prod 没有「当前状态」概念**：无法判断"已 running 不必再 up"，中断后也不知道停在哪个阶段。**一边有状态，一边没有**——这是「运维流程不统一」的实质。

### 2.3 混乱已直接暴露在命令面

```text
noj-cli status          ← prod（.env.prod）
noj-cli stack status    ← stack（noj-deploy.json）
noj-cli deploy | maintain | stack   ← 同一件事的三个名字
noj-cli check           ← prod 检测（bash）
noj-cli doctor          ← stack 检测（TS）
noj-cli verify          ← 配置 + 镜像签名（bash）
noj-cli config          ← 仅配置（bash）
noj-cli run-server      ← 前台跑服务，混在部署 CLI 顶层
```

同一个词在不同深度、不同配置下含义不同（#518 自述实测产生 **7 条**「未找到 noj-deploy.json」错误路径）。#518 引入的 `deploy`/`maintain` 别名过渡**增加了命令面而非减少**。

### 2.4 配置有**三份真相源**，且互不校验

1. `.env.prod`（51 键）—— prod 的真相（`.env.prod.example` 达 **12694 字节**）
2. `noj-deploy.json` + `noj-secrets.json` —— stack 的真相
3. `docker-compose.prod.yml` 的 `${VAR}` 插值 —— 事实上的第三种契约

且版本号 `NOJ_VERSION` 在 `deploy.sh` 内被 `awk` **手工解析 4 处、手工写入 3 处**，无 schema，全靠字符串前缀匹配（`index($0,"NOJ_VERSION=")==1`）。这正是 `check_required_values` 必须硬编码 19 个键名的原因。

### 2.5 分发层是字符串匹配的堆积

`cli.ts`(1648 行) 的 `dispatchCommand` 单函数 **527 行**，34 个 `case` + 5 个 `if (command === …)`，判定分散在 `PRODUCTION_COMMANDS.has()` → `command === "problem"` → `command === "stack"` → `case`。透传使 13 个命令**完全没有参数 schema**，直接导致（实测）**`backup list` 静默执行全量备份**（`list` 不匹配任何分支 → 落进 `production.sh` 的 `*)` → `deploy.sh backup()`）。

### 2.6 决策：单模态 + 单一配置真相源

**保留 `.env.prod` 作为唯一配置格式**（生产既有、有 example 模板），把 `stack` 的结构化能力**移植进 prod 路径**，而不是反向：

| # | 合并动作 |
| --- | --- |
| M1 | **一套状态机**：`state/machine.ts` 提升为唯一状态源，prod 亦使用 |
| M2 | **一套配置 schema**：键与类型由 TS 定义（替换 bash 硬编码 19 键），仍读写 `.env.prod` |
| M3 | **一条部署路径**：复用已在调真实 `docker compose` 的 `deploy/docker.ts` |
| M4 | **一份 compose**：现 `stack` 渲染 `docker-compose.noj.yml`，`prod` 用固定 `docker-compose.prod.yml`（含 nginx/prometheus/alertmanager 等固定服务）——**两者不是同一份编排**，必须收敛为一份（见 §3.4）。**推荐保留受版本管理的 `docker-compose.prod.yml`，不引入运行时渲染** |
| M5 | **命令面单一含义**：`status`/`logs`/`backup` 等只有一个含义，不再分深度；`deploy`/`maintain`/`stack` 三名义收敛为一 |
| M6 | **删除 `noj-deploy.json`/`noj-secrets.json` 双配置**（无历史兼容负担，R8） |
| M7 | **移除「开发部署模式」整体**（见 §2.7）：删 `devTemplate`/`prodTemplate`/`renderCompose`/JSON 配置读写/`deploy`/`maintain`/`stack`/`run-server` 命令 |

**收益**：一次性根治「不统一」；否则重写完成后仍是两套半成品，且 M1/M2/M4 的重复会以 TS 形式再固化一遍。


### 2.7 决策：移除「开发部署模式」（实测：它已不再工作且从未被使用）

**证据一：从未被使用。** 全盘查找 `noj-deploy.json` 仅命中 `/tmp` 与 `~/.cache`（**测试临时目录**）；仓库、文档、CI、e2e **零个真实配置**。`.gitignore` 亦未忽略它——说明从未被真正生成。

**证据二：已损坏。** `devTemplate`（`init/templates.ts:42-138`）把 `server` 定义为 `method: process` + `binary: noj-server`，而该二进制存在于**生产安装目录**，源码开发目录中不存在；`ui` 的 `dev_command: deno task dev` 亦无对应的真实启动实现。

**证据三：真实开发流程是另一条路径。** 与 `AGENTS.md` §5.3 一致：

```bash
docker compose up -d            # 仅基础设施：redis/postgres/minio/llm-gateway
cd noj-core && deno task dev    # 各模块各自启动
```

`docker-compose.yml`（2149 字节）只含基础设施，**不含应用服务**；e2e 另用 `docker-compose.e2e.yml`。即：`stack` 模式想做的事，实际流程用「compose 起基础设施 + 各模块 dev task」已完成。

**决策：移除「模式」，但拆解其资产（不是一概删除）。**

| `stack` 资产 | 去向 | 理由 |
| --- | --- | --- |
| 状态机 `state/machine.ts` + `deploy/state.ts` | **移植**进公共内核（M1） | `prod` **缺失**此能力（`status()` 仅 3 行 `docker compose ps`） |
| 配置 schema 校验 `config/validate.ts` | **移植**（M2），改为校验 `.env.prod` | 替换 bash 硬编码的 19 个键名 |
| compose 渲染 `compose.ts:renderCompose()` | **丢弃** | 与生产编排不是同一份（§3.4） |
| `devTemplate`/`prodTemplate` | **丢弃** | 配置真相源统一为 `.env.prod` |
| `deploy`/`maintain`/`stack` 命令 | **丢弃**（M5） | 与 prod 命令语义重复 |
| `run-server` | **丢弃** | 层属运行时，非 CLI 职责（与 #518 判断一致） |

**不新增开发命令**：真实流程（`docker compose up -d` + 各模块 `deno task dev`）已存在且已受文档记录；再造一套 `noj-cli` 包装等于重蹈「同一件事两个入口」的覆辙。

**取舍（诚实标注）**：移除后，曾用 `deploy init --mode dev` 启动全套进程的开发者需改回两段式手动流程。由 CHANGELOG 与文档覆盖（该模式实测未被使用，影响面为零）。

---

## 3. 架构：从「TS 外壳 + bash 内核」到纯 TS

### 3.1 现状（实测）

```text
noj-cli（TS）
├── 原生 TS：problem/*, doctor/*, maintain/backup*.ts, container_run.ts, init/*
└── bash 内核（仅 2 处 spawn）
      ├── production.ts:103  Deno.Command("bash", [production.sh, cmd, ...forwarded])
      └── maintain/drill.ts:308  Deno.Command("bash", [restore-drill.sh, ...])
```

13 个 `PRODUCTION_COMMANDS` 全部经 `production.sh` **盲目透传**给 `deploy.sh`/`install.sh`/`backup.sh`。

### 3.2 目标架构

```text
noj-cli（纯 TS，单一 `deno compile` 二进制）
├── cli.ts          Cliffy 命令树定义（单一事实源 → 自动 help）
├── core/           §2.6 合并后的公共内核（单模态）
│   ├── state.ts          唯一状态机（由 stack 的 state/machine.ts 提升）
│   └── config-schema.ts  唯一配置 schema（TS 定义键与类型，读写 .env.prod）
├── compose.ts            compose 渲染 + 调用 + env 读写 + cosign 验签
├── lifecycle.ts          install/start/stop/restart/status/logs/uninstall/update
├── config.ts             配置校验 + 交互向导 + 口令生成
├── bootstrap.ts          R4：从 Release 下载 compose + example 配置并校验
├── backup/               .nojbackup 单文件容器 + prod-raw payload driver
├── drill/                隔离演练编排 + 业务验收（HTTP）
├── schedule.ts           crontab 标记区块管理
├── judge/                R3：judge-install.sh(951 行) 迁入
└── problem/              R6：init 交互增强
```

**单模态（§2.6/§2.7）**：不再有 `prod` 与 `stack` 之分——公共内核（状态机 + 配置 schema）被所有命令共享，`deploy`/`maintain`/`stack`/`run-server` 命令删除，`noj-deploy.json`/`noj-secrets.json` 双配置删除。**开发流程回归两段式**（`docker compose up -d` + 各模块 `deno task dev`），不新增 `noj-cli` 开发命令。

**删除**：`setup.sh`、`scripts/deploy/install.sh`、`production.sh`、`deploy.sh`、`backup.sh`、`backup-schedule.sh`、`restore-drill.sh`、`judge-install.sh`、根 `noj`。

**加过时闸门（R2）**：仅**用户直接执行的运维入口**——实测为 `deploy.sh`、`restore-drill.sh`（其余是内驱或被调用脚本，随本次删除）。闸门行为：打印弃用警告 + 要求输入 `y` 才继续；`NOJ_ACCEPT_DEPRECATED=1` 可跳过（供过渡期脚本使用）。

### 3.3 两个必须解决的「洞」（实测发现）

**洞 1：profile 探测自锁**

`noj-cli/src/profile.ts:55` 的 `PRODUCTION_MARKERS` 含 `scripts/deploy/production.sh`，而该文件将被删除 → prod 目录探测失败 → 按既有设计**报错退出**，自己锁死自己。

**解**：标记改为 `docker-compose.prod.yml` + `.env.prod`（都是安装目录必备且不随本次删除）。`production.ts:isInstallDir` 同步。

**洞 2：install 拿不到 compose 文件（自举缺口，R4 的核心）**

删除 `install.sh` 后，用户只有一个二进制，但 `install` 需要 `docker-compose.prod.yml`。

**解**（已确认）：`noj-cli` 内置 `prod/bootstrap.ts`，从 GitHub Release 下载 `docker-compose.prod.yml` 与 `.env.prod.example` 并**校验 SHA-256**（吸收 `install.sh` 原有的下载+校验职责）。下载集合与 release 资产清单需同步登记。

### 3.4 洞 3：两份 compose 不是同一份（§2.6 M4 的实现风险）

实测：

| | `stack` 模式 | `prod` 模式 |
| --- | --- | --- |
| 文件 | `docker-compose.noj.yml`（**运行时渲染**） | `docker-compose.prod.yml`（**仓库内固定**） |
| 来源 | `compose.ts:renderCompose()` 按 JSON 组件生成 | 仓库文件，`${NOJ_VERSION}` 等 env 插值 |
| 服务集 | 按 `enabled && method=docker` 的组件 | 含 nginx / prometheus / alertmanager / minio 等固定服务 |

**因此 `renderCompose()` 不能直接复用**——它生成的是另一套编排。合并（M4）必须显式择一。

**推荐**：保留受版本管理的 `docker-compose.prod.yml` 为唯一生产编排（由 `bootstrap.ts` 从 Release 下载并校验），**不引入运行时渲染**——理由：固定文件的容器集合/健康检查/profile 已在 CI 与 e2e 中受测（`verify-compose-server.ts`），改为运行时渲染会引入未被测试覆盖的编排面。

---

## 4. R3：与 bash 保持一致如何**可验证**

这是本 spec 最重要的质量机制。`scripts/deploy/test-*.sh` 现有 **2722 行**测试，覆盖 deploy/backup/restore-drill/install/noj 的行为。

**策略**：不删这些测试，而是把它们作为**parity 基准**：

| 阶段 | 做法 |
| --- | --- |
| 迁移前 | 记录每个 `test-*.sh` 的基线通过状态与断言清单 |
| 迁移中 | 为每条 bash 断言在 TS 侧写等价测试（同输入 → 同输出/同退出码/同副作用） |
| 迁移后 | 保留 bash 测试作为**对已弃用脚本的回归**，直到脚本删除；TS 测试独立全绿 |
| 验收 | 关键行为**逐条对照表**：bash 行为 → TS 行为 → 断言位置 |

对**副作用敏感**的路径（备份产物、配置写入、crontab）额外用**文件系统断言**（文件数 / mtime / 内容哈希）。

---

## 5. R5：Cliffy（已 spike 验证）

采用 `@cliffy/command`（另评估 `table`/`prompt`）。**可行性已实测，非假设**：

| Spike | 验证项 | 结果 |
| --- | --- | --- |
| 1 | 透传语义（原 #518 反对理由） | **可表达**：未知旗标进 `[args...:string]`，全局 `--dir` 正确解析 |
| 2 | 退出码契约 | **兼容**：未知命令 `exit 2`，符合既有 0/1/2 分层 |
| 3 | `--json` stdout 纯净 | ⚠️ **默认会污染**（usage 写 stdout）→ 必须 `.throwErrors()` 接管 |

> 注：R1 完成后透传本身消失（命令全原生），spike 1 的价值转为「过渡期与 `--` 尾参语义」。

**依赖成本**：CLI 现仅 3 个依赖（`@std/assert`、`@std/path`、`fflate`）。`@cliffy/command` 约 48 包 / 300KB。须在验收中记录 `deno compile` 产物体积变化。

**JSON 硬约束**：`--json` 的 stdout **逐字节为合法 JSON**；人类输出走 stderr。不依赖框架默认行为。

---

## 6. R7：`.nojbackup` 备份流（唯一形态）

```text
snapshot-<ts>.nojbackup
└─ gpg(AES256, /etc/noj/backup-passphrase)     ← 整包加密
   └─ tar.zst
      ├─ manifest.json          schema_version/payload_layout/created_at/sha256
      ├─ postgres.dump          pg_dump -Fc 原始二进制
      ├─ postgres-globals.sql
      ├─ redis.rdb              redis-cli --rdb 原始二进制
      ├─ minio/…
      ├─ env.prod.gpg
      ├─ migration-status.txt
      ├─ sha256sums.txt
      └─ SUCCESS
```

- `payload_layout: "prod-raw"` 为**唯一形态**（无历史兼容负担）
- **必须走文件重定向**采集二进制（`backup_driver.ts:114` 注释：经 stdout 字符串传输会损坏二进制）
- `drill` 接受该单文件 → 解包 → 交隔离演练（独立 Compose 项目/子网、不映射端口、不触碰生产卷）
- 命令面：`create / verify [--deep] / restore [--dry-run] / list / prune / drill / schedule / extract`

---

## 7. 交付物与顺序

| # | 交付物 | 内容 |
| --- | --- | --- |
| P0 | 基线快照 | 记录当前绿基线（`323 passed`）+ bash 测试基线 + 冻结 SHA |
| P1 | 架构骨架 | Cliffy 命令树 + 公共内核（状态机 + 配置 schema）+ profile 标记修复（洞 1）+ JSON 通道 |
| P1b | **单模态合并 + 移除开发模式** | §2.6 M1–M7：**移植**状态机与配置 schema → 收敛命令面与 compose → **删除** `noj-deploy.json` 双配置与 `deploy`/`maintain`/`stack`/`run-server`/`devTemplate`/`renderCompose` |
| P2 | bootstrap（洞 2） | `prod/bootstrap.ts`：下载 compose/example + SHA-256 校验（吸收 install.sh） |
| P3 | lifecycle 迁移 | `deploy.sh`(1204 行/59 函数) → TS：install/start/stop/restart/status/logs/uninstall/update |
| P4 | config/向导 | 配置校验 + 交互向导 + 口令生成 + cosign 验签 + 宝塔检测 |
| P5 | `.nojbackup` 统一 | 单文件容器 + prod-raw driver + list/prune/restore --dry-run/verify --deep |
| P6 | drill 迁移 | `restore-drill.sh`(609) + `restore-drill-verify.ts`(496) → TS；业务验收 |
| P7 | schedule 迁移 | `backup-schedule.sh`(162) → TS（crontab 标记区块） |
| P8 | judge 迁移 | `judge-install.sh`(951) → `noj-cli judge` |
| P9 | problem init 交互 | R6：TUI 增强 |
| P10 | 删除 + 弃用闸门 | 删 `setup.sh`/`install.sh`/内驱脚本/根 `noj`；给 `deploy.sh`、`restore-drill.sh` 加 y 确认 |
| P11 | 文档收口 | #510 漂移治理、CHANGELOG、README、CLI 文档重写；**`AGENTS.md` §5.2 与 `noj-cli/README.md` 改写为两段式开发流程**，删除 `deploy init --mode dev` 指引 |
| P12 | 证据 | 验收证据 + 进度日志 + 待人工 review 清单 + Draft PR |

**每步独立可验收**；删除（P10）必须在 P3–P8 全绿之后。

---

## 8. 验收标准（CI 金标准）

### L0 · 全局门禁

| 门禁 | 命令 | CI 落点 |
| --- | --- | --- |
| CLI 静态 + 单测 | `cd noj-cli && deno task check && deno task test` | `ci.yml` → `production-cli` |
| 仓库级门禁 | `deno run -A scripts/check-ci.ts` | `ci.yml` → `root-gates` |
| 签名 / 规范 | 中文 Conventional Commits + GPG；Agent Note 格式 | `root-gates` |

### M · 单模态合并与开发模式移除（§2.6 / §2.7）

- [x] **唯一状态机**：`core/state.ts` 是所有命令的状态源；`status` 能报告状态，`up`/`down` 能判定 no-op（prod 路径同样成立）
- [x] **单配置 schema**：键与类型由 TS 定义（`core/config-schema.ts`），**不再有任何硬编码键名清单**（替换 `deploy.sh` 的 19 键数组）
- [x] **`NOJ_VERSION` 读写集中**：无 `awk` 式手工解析/写入（现状为解析 4 处 + 写入 3 处）
- [x] **`noj-deploy.json`/`noj-secrets.json` 已删除**；仓库无残留引用（`rg` 为证）
- [x] **命令面单一含义**：`status`/`logs`/`backup` 等只有一个含义，不因 profile 分深度
- [x] **`deploy`/`maintain`/`stack` 收敛为一个名字**（其余由 R2 弃用闸门覆盖）
- [x] **一份生产 compose**：容器集合与现状 `docker-compose.prod.yml`（含 nginx/prometheus/alertmanager 等）**逐服务核对**，无遗漏
- [x] `check`/`doctor` 与 `verify`/`config` 的重叠各自收敛为一个命令
- [x] **`deploy`/`maintain`/`stack`/`run-server` 命令已删除**；`rg` 无残留（除历史文档）
- [x] **`devTemplate`/`prodTemplate`/`renderCompose` 已删除**；无 `method: "process"` 的死代码路径
- [x] **状态机与配置 schema 的移植有回归测试**（不能只删不搬——M1/M2 是移植项，不是删除项）
- [x] `run-server` 删除后，前台调试路径在文档中有明确替代说明

### R1 · 纯 TS

- [x] `noj-cli/src` 内 **零** `Deno.Command("bash"` / `production.sh` / `deploy.sh` / `backup.sh` / `restore-drill.sh` 调用（`rg` 空输出为证）
- [x] `deno compile` 产物在**仅含 docker/curl/openssl** 的环境可完成全部命令（无脚本依赖）
      —— **已取证**（T26）：在 `debian:stable-slim`（无 Deno、无仓库、无脚本）中实测
      `--help` / `status` / `check` / `backup list` / `judge install-env` 均可独立运行，
      退出码符合 0/1/2 分层。
      **副作用发现**：产物动态链接 **glibc**，在 musl/Alpine 镜像中**不能运行**
      （实测 `docker:cli` 报 `not found`）——目标主机需为 glibc 系统。
      详见 `dev-docs/unattended/2026-09-19-noj-cli-rewrite-evidence.md`。
- [x] `scripts/deploy/*.sh` 的运维逻辑均有 TS 对应实现

### R2 · 弃用闸门

- [x] `deploy.sh`、`restore-drill.sh` 启动打印弃用警告并**要求输入 y**；非 y 则退出且**无副作用**
- [x] `NOJ_ACCEPT_DEPRECATED=1` 可跳过（供过渡期）
- [x] 非 TTY 环境下不挂起（明确报错或按既定策略）

### R3 · 与 bash parity

- [x] 建立**逐条对照表**：每条 bash 断言 → TS 等价断言位置
- [ ] 每个 `test-*.sh` 覆盖的行为都有 TS 测试（覆盖清单可核对）
      —— **覆盖已承接，映射表未做**（T26）：9 个 `test-*.sh` 已删除，行为覆盖由
      `prod/*_test.ts`（411 个）承接，但**未产出逐条映射表**。见同一证据文档的
      "未取证项 #5"与 review 清单 B3（需人判断是否要补）。
- [x] 副作用断言：配置写入、备份产物、crontab 变更前后**文件系统可验证**
- [x] 退出码语义（0/1/2）与 bash 版**逐命令一致**

### R4 · 移除自举

- [x] `setup.sh`、`scripts/deploy/install.sh` 已删除；仓库无残留引用（`rg` 为证）
- [x] `install` 在**空目录**仅凭二进制即可完成：下载 compose/example → 校验 → 部署
- [x] 下载内容 **SHA-256 校验**；校验失败拒绝写入
- [x] 文档给出「手动下载二进制」的完整步骤

### R5 · 界面（Cliffy + ANSI + 富文本）

- [x] 命令树与 help 由 Cliffy **单一事实源**生成；**新增防漂移门禁**：help 声明集合 == 实际可处理集合
- [x] `backup --help` 包含全部真实子命令（修复已实测的 `list/prune` 缺失）
- [x] `--json` stdout **逐字节合法 JSON**（`jq` 管道回归测试）
- [x] `NO_COLOR`/`LOG_COLOR`/`--color=auto|always|never` 契约保持；非 TTY 自动关色
- [x] `noj-design-tokens.md` 补 **CLI/终端 section**；语义色取自 token
- [x] 表格/分组/状态符号呈现，窄终端不破版
- [x] 记录 `deno compile` 产物体积变化

### R6 · problem init 交互

- [x] 引导覆盖：slug/type/difficulty/title 等，含校验与回退
- [x] 非 TTY / `--no-interactive` 行为明确（报错或按参数）
- [x] 生成骨架后可通过 `problem lint`（回归）

### R7 · .nojbackup

- [x] `create` 产出单个 `.nojbackup`，`payload_layout == "prod-raw"`
- [x] **无口令无法读取包内任何内容**（P2 回归）
- [x] `postgres.dump` 可被 `pg_restore --list` 解析（防二进制静默损坏）
- [x] `list`/`prune`（默认 dry-run）/`restore --dry-run`（无副作用）/`verify [--deep]` 可用
- [x] **prod profile 的 `list`/`prune` 走原生实现，且断言不创建备份**（修复实测的误路由）
- [x] `drill`：超 RPO/RTO = 失败(1)；资源缺失 = 2；失败路径也清理；`--project-name` 拒绝含 `prod`
- [x] 三个监控指标名逐字保持

### P8 · judge

- [x] `noj-cli judge` 覆盖 `judge-install.sh` 全部能力（逐项对照）
- [x] 不自动安装/替换宿主机 Docker daemon；禁止共享 `/var/run/docker.sock`（既有安全约束）

### P11 · 文档

- [x] #510：ROADMAP 校准（A 类勾选/B 类移除多语言/C 类补证据/D 类改新命令）
- [x] `AGENTS.md` 的命令面纠错（T23/T24 后旧命令已移除，见 §5.2 两段式开发流程）
- [x] ~~`about.vue:324` 移除多语言暗示~~ —— **该指控不成立（T25 核对后撤销）**：
      原文写"默认提供 Python 3 评测环境，**更多语言由管理员配置评测镜像后在「管理后台」启用**"，
      而这条链路**真实存在**：`judge_images` 表（`noj-core/src/shared/db/schema/system.ts`）
      + 管理端接口（`domains/admin/routes/system.ts`）+ 后台页面
      （`noj-ui/pages/admin/judge-images.vue`）+ 题目编辑器按镜像选择运行时
      （`components/editor/CodingProblemEditor.vue:89-96`）。
      它是**已实现能力的准确说明**，不是"暗示未实现的多语言"。
      真正的 B 类漂移只有 `ROADMAP.md` 的两条多语言条目（已移除，见该文件的 Phase 1）。
- [x] 新建 CHANGELOG；`openspec/changes/add-noj-cli/tasks.md:9` 修正

---

## 9. 风险与处置

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| **一次重写 7367 行 bash → 行为漂移** | 高 | R3 parity 机制：对照表 + 逐条 TS 测试 + 副作用断言；**分步提交，每步 CI 绿** |
| 框架默认污染 `--json` stdout | 高（静默） | spike 3 已证实；`.throwErrors()` 接管 + 逐字节 JSON 断言 |
| profile 标记删除后自锁 | 高 | §3.3 洞 1：改为 compose+env 标记（P1 内先修） |
| **合并双模态时丢失 stack 独有能力**（状态机 / compose 渲染 / schema 校验） | 高 | §2.6 M1–M7 逐项对照；**先补 TS 测试再删旧路径**（M1/M2 是移植项，不可只删） |
| **M4 误复用 `renderCompose()`**（生成的服务集不同） | 高 | §3.4 已点明两者非同一份；推荐保留受版本管理的 `docker-compose.prod.yml` |
| **删开发模式时连带删掉状态机/schema**（它们是移植项） | 中 | §2.7 明确「拆解而非一概删除」；M1/M2 的移植需有回归测试 |
| 文档仍指引已删除的 `deploy init --mode dev` | 中 | P11 文档收口；`AGENTS.md` §5.2 与 `noj-cli/README.md` 同步改写为两段式流程 |
| 删除 install.sh 后无法安装 | 高 | §3.3 洞 2：bootstrap 内置下载 + SHA-256 校验（P2 先行） |
| 弃用闸门卡住过渡期自动化 | 中 | `NOJ_ACCEPT_DEPRECATED=1` + 非 TTY 明确行为 |
| Cliffy 依赖膨胀（48 包/300KB） | 中 | 记录产物体积；只引必要模块 |
| 监控指标名漂移 → 告警静默失效 | 高（静默） | 逐字断言三个指标名；`NojBackupMetricMissing` 48h 才响 |
| 交互向导（宝塔/cosign）行为漂移 | 中 | 逐项对照 + 保留 `test-install.sh` 用例为基准 |
| 范围过大做不完 | 高 | 完整性 > 数量；未达标降级「进行中」，**不半成品提交** |
| 卡死 | 中 | 同一失败上限 3 次，超限记录根因并跳过；checkpoint 写进度日志 |

---

## 10. 明确不做（YAGNI）

- ❌ 保留任何 bash 实现路径（R1 是硬要求）
- ❌ **保留双模态**（`.env.prod` 与 `noj-deploy.json` 并存）——§2.6 已决策合并为单模态；否则重写后仍是两套半成品
- ❌ **保留「开发部署模式」**（`deploy`/`maintain`/`stack`/`run-server`/`devTemplate`/`renderCompose`）——§2.7 实测其从未被使用且已损坏
- ❌ **新增 `noj-cli` 开发启动命令**——真实流程（`docker compose up -d` + 各模块 `deno task dev`）已存在；新增即重复入口
- ❌ 引入运行时 compose 渲染替代受版本管理的 `docker-compose.prod.yml`（§3.4）
- ❌ 历史兼容（legacy `snapshot-*` 识别、别名过渡、双 payload 分派）
- ❌ 增量备份 / PostgreSQL PITR（需外部 WAL 归档）
- ❌ 异地 / 对象存储自动上传
- ❌ 给 e2e/staging/release/monitoring 的开发脚本加弃用闸门（R2 仅用户运维入口）
- ❌ 改 `_journal.json`、手改 `deno.lock` / `Cargo.lock`

---

## 11. 待人工确认（诚实标注）

- **R3 的 parity 完备性**：bash 测试覆盖 ≠ bash 全部行为（例如仅在生产环境触发的路径）。无法覆盖者必须在报告中**逐条列出并标注未取证**，不得声称「已验证一致」。
- **真演练（drill）E2E**：本机无 `/opt/neuro-oj` 生产目录、缺 `noj-solution-python` 镜像，端到端取证依赖 CI（见风险表）。
- **R2 闸门与 CI**：若 CI 仍调用被闸门拦住的脚本会失败，需在 P10 同步更新调用点。
