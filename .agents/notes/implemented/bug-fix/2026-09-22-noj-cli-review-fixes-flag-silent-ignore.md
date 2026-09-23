# Agent Note: noj-cli 评审收尾——被静默忽略的旗标、备份空间守卫与恢复口令接线

Status: implemented

## Problem

PR #540（noj-cli 纯 TS 重写）在评审中仍有同一类缺陷的多个新实例：**旗标被接受却
静默无效**，以及**脚本删除后守卫整体消失**。该 PR 自己把这类形态定义为 Critical
（见 `noj-cli/src/prod/cli.ts` 的 `UNIMPLEMENTED_PROD_FLAGS`），因此这些实例与
PR 的目标直接冲突：

1. **`judge install --socket-gid` 被静默忽略**。`JudgeInstallOptions.socketGid`
   有完整实现（写入 `JUDGE_DOCKER_SOCKET_GID`），但 CLI 层从未转发；该旗标也不在
   拒绝表里。后果：在 socket GID ≠ 默认 10001 的主机上，按
   `noj-docs/docs/operators/judge-workers.md` 的文档流程安装必然失败，且**留下
   半成品 `.env.judge`（GID=10001）**，只能手工编辑。`--redis-url` 在既有配置上
   同样被静默忽略（只保留 `updateVersion`，无任何提示）。

2. **`backup create --retention-days` / `--min-free-mb` 被静默吞掉，且空间守卫
   整体消失**。bash `backup.sh:113-121` 的 `check_free_space` 在采集前校验可用
   空间；TS 版既没有该检查，也没有消费 `--min-free-mb`，而 `--retention-days`
   甚至被登记进 `positionals()` 的 `valueTaking`（防止其值被当位置参数）却没有
   任何解析点。备份场景最常见的自伤方式——把磁盘写满——在 TS 侧完全没有防护。

3. **`--passphrase-file` 家族的环境变量从未接线**。`drill` 的报错文案明示
   "必须提供 `--passphrase-file` 或 `NOJ_BACKUP_PASSPHRASE_FILE`"，但该变量对
   `drill`/`verify`/`restore` 全部未接线（设了仍报同一错误）；而 `install` 恰会
   把它回填进 `.env.prod`，`backup schedule` 也读它——形成"安装时写进去、
   备份校验时用不上"。

4. **文档承诺的 `backup restore --dry-run` 被拒绝**。README 与 CHANGELOG 都写
   `noj-cli backup restore <快照> --dry-run`，而该旗标在拒绝表里 → 退出码 2
   （"生产命令尚未实现 --dry-run"）。真正的 dry-run 路径是"省略 `--confirm`"，
   与文档表述不一致。

5. **次要**：`drill` 未透传 `encrypted`（`--no-encrypt` 的产物无法演练）；
   `restore --confirm` 把 docker 写死（`NOJ_DEPLOY_DOCKER_BIN` 不生效）；
   演练覆盖文件里的 `verifier` 服务在 TS 重写后已无使用点；`judge install` 的
   help 不列必需旗标；Release 资产（compose/example）本次才纳入发布流程，
   对既有 tag 不可用一事未在文档说明。

## Decision

1. **把旗标接到实现**：`judge install` 转发 `--socket-gid`；`backup create` 消费
   `--retention-days`（写入 manifest + 成功后清理过期快照）与 `--min-free-mb`
   （采集前空间守卫，缺省值同样支持 `NOJ_BACKUP_RETENTION_DAYS` /
   `NOJ_BACKUP_MIN_FREE_MB` 环境变量）；`backup restore` 接受 `--dry-run`
   （与 `--confirm` 互斥，互斥检查在目录解析之前完成）。
2. **既有配置优先时必须回报被忽略的键**：`writeJudgeEnv` 的结果增加 `ignored`
   字段，`judge install` 打印"以下旗标未生效（既有配置优先，需手工修改 …）"。
   静默忽略与"旗标被吞"是同一类缺陷。
3. **口令统一解析**：新增 `resolveBackupPassphrase`
   （`--passphrase-file` > `NOJ_BACKUP_PASSPHRASE_FILE` > `.env.prod` 同名键），
   `verify`/`restore`/`drill` 三处全部接线。`--no-encrypt` 的语义明确为"只关闭
   整包那一层"——包内 `env.prod.gpg` 恒为加密，故这些命令始终需要口令。
4. **恢复路径尊重 `NOJ_DEPLOY_DOCKER_BIN`**：`restoreConfirmed` 与 `drill` 从环境
   取 docker 可执行名，不再写死 `docker`。
5. **删除演练覆盖文件里的死服务 `verifier`**（TS 重写后业务验收由 CLI 直接发
   HTTP，该服务无任何使用点，只会出现在 compose 解析面并多拉一个镜像）。
6. **文档与 help 同步**：`judge install` 的必需旗标写进 `--help`；
   `judge-workers.md` 改为显式参数形式并说明"既有配置优先"；
   README 补 Release 资产兼容范围；CHANGELOG 的备份表补新旗标与口令优先级。
7. **补测试**（`noj-cli/src/prod/cli_test.ts` 6 条）：`--socket-gid` 转发、
   `--dry-run` 被接受、`--dry-run` 与 `--confirm` 互斥、空间不足必须拒绝、
   `--retention-days` 非法值在采集前失败、`--retention-days`/`--min-free-mb`
   被真实消费。

## Alternatives considered

- **把未实现的旗标一律放进拒绝表**：能消除"静默"，但 `--retention-days` /
  `--min-free-mb` / `--socket-gid` 都是**文档与 bash 都承诺**的能力，拒绝等于把
  功能缺口固化成"不能用"。选择实现它们，只把确实未实现的（`--dry-run` 于其他
  生产命令、`--panel`）留在拒绝表。
- **`--retention-days` 只写 manifest 不清理**：与 bash 行为不一致（bash 成功后
  调 `prune_old_snapshots`），且会让"保留天数"变成纯元数据——用户以为旧快照被
  清理，实际磁盘持续增长。
- **让 `--dry-run` 成为 `backup restore` 的独立分支**：与"省略 `--confirm`"重复。
  选择把两者映射到同一路径，并在 help/README 中说明等价关系。

## Consequences

- `judge install` 在非默认 GID 主机上按文档即可完成，且不再留下错误的半成品配置；
  既有配置上的旗标覆盖会显式提示。
- `backup create` 恢复了 bash 的磁盘守卫，并真正按保留天数清理；参数校验全部
  发生在采集之前。
- `drill`/`verify`/`restore` 的口令来源与 `.env.prod` / 安装流程自洽。
- 演练不再声明无用的 `verifier` 服务；非默认 docker 路径的主机上恢复/演练可用。
- 已知残留（不在本次范围）：`backup restore --confirm` 的完整恢复序列仍只有单测
  与代码级核对，未做真实 pg_restore/redis/minio 往返（CI 的 E2E 不覆盖 restore
  编排）；`--json` 模式下 `backup create` 的"已清理过期快照"提示走 stderr，
  不进 JSON 载荷。
