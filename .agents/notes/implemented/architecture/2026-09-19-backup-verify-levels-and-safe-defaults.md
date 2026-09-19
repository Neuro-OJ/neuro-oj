# Agent Note: 备份命令面的三档 verify、默认 dry-run 与"不创建备份"约束

Status: implemented

## Problem

`.nojbackup` 容器的能力层（T17）就位后，命令面有三个各自独立的问题：

1. **`verify` 的强度不该是一个开关**。bash `verify_snapshot`（`backup.sh:302-334`）
   只做文件完整性（`sha256sums` + 哨兵），而"文件完整"离"能恢复"还有距离：
   归档解不开、RDB 不是 RDB、Postgres dump 结构不可解析，都能在 sha256 全通过时
   存在。用户需要一个**成本可预期**的强度梯度，而不是"要么快要么全"。
2. **`prune` 的默认行为必须是最安全的那个**。删备份不可逆，而
   `maintain/backup_index.ts` 的 `planPrune` 已经确立了正确的安全默认
   （两个条件都不给则什么都不删；legacy 目录默认保留）。命令层若"手滑"默认落地，
   就绕过了这些默认。
3. **这些命令都不该创建备份**。实测过的缺陷：prod profile 的 `list`/`prune`
   曾误路由到 JSON 模态的创建路径——一个只读命令把备份目录写满了。

## Decision

新增 `noj-cli/src/prod/backup/commands.ts`，四条约束各有对应实现：

1. **三档累加**（`verifyCommand`）。默认档=文件完整性；`--deep`=结构可解析
   （`postgres.restore-list` 非空、`redis.rdb` 首字节为 `REDIS` 魔术串、
   `minio/` 目录存在、`env.prod.gpg` 可解密）；`--payload-sha`=容器摘要与
   **同级 sidecar** 比对。**累加**是刻意的：每档以上一档为前提，因此"加旗标"
   不可能让弱检查通过强检查失败的东西。`--deep` 的 `redis.rdb` 检查读**首字节**
   而非整文件（RDB 魔术串），避免为一次结构校验读入数百 MB。
2. **`prune` 默认 dry-run**：`confirm !== true` 时 `pruneBackups` 只返回计划，
   `deleted` 恒空。判定**完全委托** `planPrune`——包括"无条件则不删"与
   "legacy 默认保留"两条安全默认，命令层不重写。
3. **`restore --dry-run` 无副作用**：解包、校验、步骤规划**全部真实发生**
   （否则 dry-run 会漏掉"快照根本解不开"这类问题），但 `RestorePlanOptions.ops`
   的类型里**只有** `gpgDecrypt`/`untarZst`——没有采集能力、没有 docker 调用
   能力，"dry-run 会碰 docker"在类型上就不可能。
4. **口令语义如实分层**：整包加密的容器**没有口令就无法校验任何东西**
   （这是整包加密的必然后果，也是安全收益），故明确抛错而不是"跳过部分检查"；
   只有未加密容器（`--no-encrypt`）+ 缺口令时，才走"跳过环境文件解密"分支，
   并置 `skippedDecrypt` 让调用方如实报告——静默通过会让深层检查名不副实。

**整包摘要的落点在本任务被修正**（T17 的实现缺陷）：T17 让 `manifest.json` 记录
归档的 SHA-256，但那要求两轮打包且**第二轮之后摘要已变**——manifest 位于容器
**内部**，无法记录自己所在文件的摘要（无限回归）。修正后 manifest 内不放整包摘要
（单轮打包即可），摘要落在与容器**同级**的 `<容器名>.sha256`，格式沿用仓库既有的
Release 资产约定（可直接 `sha256sum -c`）。

同时修正 T17 的第二处缺陷：`sha256sums.txt` 漏掉了 `manifest.json`
（bash `write_checksums` 覆盖除自身外的**全部**文件，含它之前写入的 manifest）。
写入顺序改为"先 manifest、再 checksums"。

## Alternatives considered

- **让 `verify --deep` 复算 `tar.zst` 摘要并与 manifest 比对**：这是 T17 的原设计，
  已证明不可能（自指）。改落 sidecar 后 `--payload-sha` 的语义也更准确：
  它校验的是**磁盘上的那个文件**，而不是包内某个中间产物。
- **把 sidecar 摘要说成"防篡改"**：不成立，且危险。能改 `.nojbackup` 的人同样能改
  同级 `.sha256`。它在 JSDoc、计划与 Agent Note 中一律被描述为**意外损坏检测**
  （介质位翻转 / 拷贝截断 / 下载不完整 / 误改）。防篡改需要非对称签名，而对称
  口令体系下"持有口令者可重写一切"。
- **`--deep` 读整个 `redis.rdb` 校验**：读首字节的 `REDIS` 魔术串已能区分
  "这是 RDB"与"这是错误输出/空文件"，而整读会为标准检查引入无谓的 IO。
- **命令层自己实现保留策略**：`maintain/backup_index.ts` 的 `planPrune` 已有正确
  的安全默认与测试；重写一遍等于把两条安全默认再赌一次。
- **把 `defaultBackupDir` 直接复用 `maintain/backup.ts` 的同名导出**：签名不同
  （那个接 `DeployConfig`），且同名会让包入口的再导出撞名。用具名 `prodBackupDir`
  显式区分，并注明这是双模态遗留、T23 一并收敛——而不是靠改名掩盖撞名本身。
- **让 `restore` 的非 dry-run 路径也在本任务实现**：它是不可逆操作（覆盖目标
  数据卷），需要与 drill 同级的隔离与确认设计。任务书的验收只要求 dry-run
  无副作用，越界实现会引入未经验证的破坏性路径。

## Consequences

- **三档强度可预期且有测试锁死**：逐档注入缺陷（篡改 payload 字节 / 非 `REDIS`
  内容 / sidecar 缺失），断言**恰好触发对应档**的失败且低档不误报——高档在低档
  失败时必然失败这一性质因此不可回归。
- **"不创建备份"成为可断言的硬约束**：测试对四个命令前后取备份目录的**指纹**
  （文件清单 + 每项摘要）并断言逐项不变，误路由回归会立刻转红。
- **`--payload-sha` 的保证边界是诚实的**：只覆盖意外损坏。任何把它当作
  完整性/真实性证明的用法都是误用，这一点在三处文档中一致。
- **prune 的安全性来自复用而非重写**：`planPrune` 的两条安全默认（无条件不删、
  legacy 保留）对 prod 侧自动生效，且已有测试覆盖。
- **整包加密容器要求口令才能校验**：`verify` 在没有口令时**报错**而不是降级——
  这是 T17「整包加密」裁决的必然后果。操作含义：**口令文件必须与备份分开保管**，
  丢失口令等于连"这份备份是否完好"都无法判断（更不用说恢复）。
- **`maintain/` 与 `prod/backup/` 并存**：前者是 JSON 模态的备份路径，本任务只
  复用其**纯逻辑**（`listBackups`/`planPrune`），不复制其命令编排。两者的
  同名导出（`defaultBackupDir`）以 `prod` 前缀区分，待 T23 收敛双模态时一并处理。
- **命令尚未接入 CLI 解析层**：`backup create/verify/list/prune/restore` 的
  参数解析与退出码映射随 T24（删除 bash 前的接线）落地；本任务交付的是可注入的
  命令实现与其结果形状。
