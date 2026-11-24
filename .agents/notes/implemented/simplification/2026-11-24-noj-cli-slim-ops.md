# Agent Note: noj-cli 精简：移除恢复演练、备份调度与磁盘空间预估

Status: implemented

## Problem

noj-cli 约 2.8 万行源码、2.7 万行测试，其中生产运维（`src/prod/`）占 77%。
有几块功能的代价和实际使用不成比例：

- `backup drill`（约 2.6k 行 + 1.6k 行测试）：需要专门的隔离 rootless Docker
  daemon，外加 `scripts/deploy/restore-drill-verify.ts`、noj-tests 契约 E2E、
  Prometheus 演练过期告警，整条链路维护成本高，而运维流程里很少真正执行。
- `backup schedule`：自己管理 crontab 标记区块，本质上就是一行系统 cron。
- 按数据量估算磁盘空间的预检（#772 引入的 `disk-space.ts`，约 760 行）：
  需要采样 PG/Redis/MinIO 数据量，并探测分区与 Docker 根目录，侵入了
  `update`、`backup create`、`check`、`status` 四条路径。

## Decision

保留 `problem` 全部子命令，以及核心运维命令（install/start/stop/status/logs/
update/backup create·verify·list·prune·restore/maintain/judge/uninstall）。删除：

- `backup drill` 与 `src/prod/drill/`、`restore-drill-verify.ts`、
  `restore_drill_contract.test.ts`、`NojRestoreDrillStale` 告警。
- `backup schedule` 与 `schedule.ts`；文档改为给出系统 cron 示例。
- `disk-space.ts` 及其在 update、check、status、backup create 中的接入点。
  `backup create` 回到 #772 之前的单一下限守卫：`df -Pk` 可用空间低于
  `--min-free-mb`（或进程环境变量 `NOJ_BACKUP_MIN_FREE_MB`，默认 1024）即中止。

#772 中的流式打包和崩溃残留清理（`stale-cleanup.ts`）关系到正确性，予以保留。
`judge` 子命令是独立 Judge 节点的部署入口，不在本次范围内。

## Alternatives considered

- **整体删除 noj-cli**：已部署节点依赖 `noj-cli update` 升级，Release 流水线、
  本地验题门禁和 judge 本地评测也绑定它，代价过大。
- **只保留 `problem`**：会失去“升级前强制备份 + 排空”这条防事故路径。
- **保留 drill，只删调度和预估**：drill 是维护成本最高的一块，单独保留收益最低。

## Consequences

- 净删除约 1 万行（noj-cli 源码与测试约 8.2k 行）。
- 用过 `backup drill` 或 `backup schedule` 的运维脚本会报用法错误；已安装的
  crontab 区块仍调用 `backup create`，可继续运行，但不再能通过 CLI 管理。
- `.env.prod` 中的 `NOJ_BACKUP_MIN_FREE_MB` 不再被读取，只认旗标和进程环境变量。
- `status --json` 输出不再包含 `disk` 字段。
- 业务级恢复验收改为人工流程：在独立主机上安装同版本后执行
  `backup restore --confirm`。
