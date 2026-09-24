# Agent Note: 隔离恢复演练的原生移植与形态反转

Status: implemented

## Problem

`backup drill` 是备份体系里**唯一的"真的能恢复"**保证（`verify` 只证文件完整，
`verify --deep` 只证结构可解析），但它此前不是原生实现：

1. **它是 `restore-drill.sh` 的薄包装**：`maintain/drill.ts` 用
   `new Deno.Command("bash", { args: buildDrillArgs(opts) })` 把 609 行 bash 转发出去。
   这正是 R1 要消灭的形态（`noj-cli/src` 内**零**脚本调用）。
2. **业务验收要多一个镜像**：`restore-drill.sh:288` 把 `restore-drill-verify.ts`
   挂进 `denoland/deno:debian-2.9.5@sha256:…` 容器里跑，于是演练多一个固定 digest
   的镜像依赖。
3. **它拒绝单文件快照**：`maintain/drill.ts:168-181` 的
   `assertDrillSnapshotSupported` 明确拒绝 `.nojbackup`，理由是"两种形态的内部布局
   不同（base64 文本 vs 原始二进制）、解包后也无法安全恢复"。那是 T17 之前的
   事实——当时单文件属于 JSON 模态，`postgres.dump` 是 base64 文本。

同时 bash 的等价逻辑与 docker 调用交织在 609 行里，无法单测"参数错误是否在起容器
**之前**被拦下"——而这正是 #516 的一条硬验收。

## Decision

新增 `noj-cli/src/prod/drill/`，四个模块按"判定 / 验收 / 报告 / 编排"分层：

1. **`plan.ts`：判定全为纯函数**。把 `preflight()`/`prepare_compose_override()`/
   `check_secret_file()` 等的**判定**与**执行**分开，执行只在编排层且一切经注入
   runner。于是"资源/参数错误 = 退出码 2 且**零 compose 调用**"成为可断言的
   性质（此前只能靠读 bash 相信它）。参数校验（项目名拒绝 `prod`、子网 CIDR 与
   主机位）**复用** `maintain/drill.ts` 的实现——那里已修过两轮评审
   （P1 = 单文件必须在参数阶段拒绝；P2 = 子网必须挡掉 Docker 也会拒绝的输入），
   重写等于把两条修复再赌一次。
2. **`verify.ts`：业务验收由 CLI 直发 HTTP**。隔离演练**不映射宿主机端口**
   （#516 要求），因此不能走 `localhost:8080`；取法是经**容器 IP**：
   `compose ps -q core` → `docker inspect` 读演练网络内的 IP →
   `http://<ip>:8000/api/v1`。这样既保住隔离性，又消掉了 deno 镜像依赖。
   登录失败**立即短路**（原实现 `:424-427` 的语义）——未认证下后续步骤必然失败，
   继续跑只会用噪声日志掩盖首个失败原因。
3. **`report.ts`：字段名与指标名逐字保持**。报告与指标是运维、runbook 与告警的
   接口（`noj-alerts.yml:236` 直接引用
   `noj_restore_drill_last_success_unix_time`），而它们不在本仓库的测试覆盖里
   （`check-runbooks.ts` 只做静态检查）。故用逐字常量而非"更优雅的命名"。
4. **`drill.ts`：编排，含失败也清理**。`postgres.dump`/`redis.rdb` 经**文件重定向**
   搬运（T17 `driver.ts` 的同一语义）；`seed_drill_admin` 的 SQL 经临时文件喂
   stdin（避免口令出现在 `ps` 可见的 argv 里）；清理失败**不掩盖**原始错误。

**形态反转**：T19 **接受** `.nojbackup` 单文件（校验
`payload_layout == "prod-raw"` → 解包 → 交给隔离编排）。T17 之后单文件是唯一形态，
且其内部布局与生产目录快照**逐文件一致**（原始二进制 `postgres.dump`、存在
`env.prod.gpg`、有 `postgres.restore-list`）——`maintain/drill.ts` 拒绝它的**前提
已消失**。旧的拒绝逻辑连同其理由一并作废，T23 删除双模态时移除该模块。

## Alternatives considered

- **继续薄包装 bash，只在 T24 才移植**：R1 的验收要求 `noj-cli/src` 内零
  `Deno.Command("bash", …)`，`maintain/drill.ts` 是仅存的违例之一；留到 T24 会
  让"删 bash"那一步同时承担移植与删除两种风险。
- **业务验收仍走容器（保留 deno 镜像）**：多一个固定 digest 的镜像依赖，
  且镜像内的脚本与 CLI 版本可能漂移（`restore-drill-verify.ts` 与 CLI 各自演进）。
  经容器 IP 直连 HTTP 的代价是"CLI 主机需能直达 docker 网桥地址"——这是 Linux
  演练环境的常态（演练本就只面向 Linux 生产）。
- **把 `assertDrillProjectName`/`assertSubnetCidr` 复制进 `prod/drill/`**：
  那两份实现带 P1/P2 评审修复的历史，复制后任一侧修复都不会传播。
  改为 import 复用，并在注释里标明 T23 收敛时搬迁。
- **让前置失败也写报告**：bash 在 `preflight` 阶段 `return 0`（不写）。此时报告
  路径可能尚未确定，且"参数错"不是演练结果，写一份 `result=failed` 报告会让
  运维误以为演练跑过。
- **RPO 时间戳不可解析时按 0 小时处理（视为很新鲜）**：会让一份时间戳损坏的备份
  "通过"新鲜度检查。改为 `Infinity`（必然不达标），与 bash 的实际效果一致但表达
  更明确：无法判断有多旧，与很旧，在 RPO 上都应不达标。
- **`--keep` 时也刷新指标**：`--keep` 是"保留现场供人工检查"，此时演练可能因
  RPO/RTO 超限而失败；刷新"最近一次成功"指标会掩盖这一点。指标只在
  **成功且 RPO/RTO 达标**时写。

## Consequences

- **R1 在 drill 路径上兑现**：`prod/drill/` 内零 `bash`、零仓库脚本调用；
  唯一的 shell 用法是 `sh -c '… < "$src"'` 做 stdin 文件重定向（路径经位置参数
  传递、不进脚本正文），与 T17 的同一语义。
- **退出码语义可断言**：三条断言直接锁 0/1/2——RPO 超限 → 1；docker 不可用 → 2
  且不写报告；项目名含 `prod` → 2 且**零 compose 调用**。
- **失败也清理可断言**：注入 `pg_restore` 失败 → 仍执行
  `down -v --remove-orphans`；`--keep` 时不清理；`pg_restore` 与 `down` **同时**
  失败时退出码仍是 1，原始原因在 `message` 主体。
- **演练少一个镜像依赖**：不再需要 `denoland/deno:debian-2.9.5@sha256:…`。
- **单文件快照可直接演练**：与 `backup create` 的产物形态一致，用户无需为演练
  准备目录形态的快照。
- **29 个用例**，全部注入（runner / fetch / 时间 / 睡眠），不起容器、不触网；
  测试内的容器用**长度前缀的二进制安全格式**，避免文本行解析在二进制边界
  （NUL / 高位字节）上悄悄破坏载荷。
- **`maintain/drill.ts` 仍在**（T23 删除）：它保留旧的双模态路径与命令接线；
  `prod/drill/` 只 import 它的两个纯校验函数，因此删除时只需处理两处引用。
- **`cli.ts` 仍路由到 `maintain/drill.ts`**：命令面接线随 T24（删除 bash 前）
  落地；本次交付的是可注入的原生实现与其结果形状。
- **报告权限 600 / 指标 644**：验收日志可能含题目 ID 与内部 URL，不应全局可读；
  指标要被 node_exporter 的 textfile collector 读取，故 644。
