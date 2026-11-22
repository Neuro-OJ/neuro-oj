# Agent Note: noj-cli 备份与升级前按数据量预估磁盘空间、流式降峰与崩溃残留清理

Status: implemented

## Problem

生产节点（#623）在 `noj-cli update`
的备份阶段出现磁盘写满风险，旧实现存在四处缺口：

1. `runBackupCreate` 只按固定 `--min-free-mb`（默认 1024
   MB）下限校验，与实际数据体量无关；
2. 备份流程先在 staging 落全量文件、再产出 `.tar.zst`、再经 `gpg` 加密后才在
   `finally` 统一删除临时数据，磁盘峰值达到约「1 份原始数据 + 2 份压缩产物」；
3. `noj-cli update` 先写升级暂存文件与执行备份，之后直接拉取镜像（无 Judge 约
   1.5 GiB、含 Judge 约 4 GiB），全程未结合备份目录分区与 Docker
   数据目录（`DockerRootDir`）分区做整体验证；
4. 若上次备份进程异常终止，`.nojbackup-staging-*` 与 `.tmp`
   临时产物会持续占用空间。

## Decision

1. **流式降峰与分步释放**：在 `CommandRunner` 增加无 shell 管道
   `pipe(first, second)`，在 `createProdPayloadOps` 实现
   `tar -I zstd | gpg --symmetric --output` 流式直出，省去中间 `.tar.zst`
   产物；同时将 `chmodPrivate` 前置并在打包/加密每步落盘后立即删除
   `staging`，将备份峰值需求压降至
   `max(兜底下限, 原始数据 + ceil(原始数据 × 0.85) + 512 MiB)`。
2. **启动前安全清理与排他锁**：新增 `stale-cleanup.ts`，通过
   `.nojbackup-create.lock`（记录 `{ pid, startedAt }`）及文件名前缀嵌入 PID
   识别进程存活状态；仅在确认进程已死亡时清理受控临时命名残留（绝不触碰已提交
   `.nojbackup` / `.sha256` / `metrics` / `upgrade-state.json`），存活锁或存活
   PID 直接中止或跳过以避免误删并发任务。陈旧锁回收经
   `.nojbackup-create.lock.reclaim`（`createNew` 互斥，60s
   后视为崩溃残留）串行化， 并在互斥内比对锁文件内容与
   inode，与先前观测不一致即重新判定，防止基于过期
   观测的进程删除他人刚获取的新锁导致两路备份并发。
3. **数据量估算与同/异分区预检**：新增 `disk-space.ts`，采样
   PG（`pg_database_size`）、Redis（`INFO memory`）、MinIO（`mc du --json`），并在
   `backup create` 与 `update` 写入任何临时文件、备份与 compose
   变更前完成预检；`update` 通过 `docker info --format '{{.DockerRootDir}}'`
   自动区分同分区合并校验与异分区分开校验，并将估算结果复用给随后的升级前备份以避免重复扫描对象存储。
4. **`check` / `verify` / `status` 展示分区余量**：统一展示安装目录与 Docker
   数据目录分区余量，在可用 `< 5 GiB` / 使用率 `>= 85%`（严重 `< 1 GiB` /
   `>= 95%`）时输出告警。

## Alternatives considered

- **直接提高固定 `--min-free-mb` 默认值**：无法适配从几百 MB 到数十 GB
  不等的真实 MinIO/PG 增量，对小盘节点误杀、对大盘节点仍不够；故保留
  `--min-free-mb` 作为兜底下限并与实测数据量峰值取 `max`。
- **继续保留两阶段文件打包并用脚本包装管道**：违反 `noj-cli/src/` R1 零 bash
  调用门禁，且无法消除 `tar.zst` 中间副本的峰值空间占用；改为
  `CommandRunner.pipe` 纯 TS 子进程流连接并在无法探测的测试 fake runner
  上兼容回退。

## Consequences

- `noj-cli backup create` 与 `noj-cli update`
  在空间不足时可在零写入前失败并输出明确「需要 X / 可用 Y」；
- 备份流程由双份中间压缩产物降为流式单份输出，显著降低中小盘生产宿主的升级/备份写满风险；
- `status --json` 与既有生命周期单测在无 `df`/`docker info` 输出的轻量 fake
  下保持向后兼容（仅可探测到分区时写入 `disk` 字段）。
