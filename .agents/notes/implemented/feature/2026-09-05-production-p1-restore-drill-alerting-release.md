# Agent Note: 生产上线 P1 收口——隔离恢复演练、告警投递与发布就绪窗口

Status: implemented

## Problem

上线准备评估（issue #428 / #429 / #431）识别出三个 P1 缺口：

1. `scripts/deploy/backup.sh drill` 只做文件级校验，报告仍把"隔离 Compose 恢复"列为
   next_step，文件校验成功不能证明业务可恢复。
2. 监控配置缺少 Alertmanager 投递配置、core 抓取失联检测、备份新鲜度检测，API 错误率
   规则使用进程累计比例会稀释近期故障；Runbook 链接指向的锚点并不存在。
3. release.yml 仅由 `release.prereleased` 触发，GitHub 草稿预发布转为可见时不会触发；
   CLI 又要求 Release 已含资产；发布可见但构建/上传未完成时，安装器会选中不可安装的版本。

## Decision

- 新增 `scripts/deploy/restore-drill.sh` + `restore-drill-verify.ts`：把快照恢复到独立
  Compose 项目（独立卷/子网/无宿主机端口），恢复后经真实 API 验收登录、题目读取、
  附件（支持包）下载与一次真实双容器评测；报告记录快照时间、恢复耗时、数据核对、
  业务结果与 RPO/RTO 达标情况；损坏快照、解密失败、恢复失败、业务失败均非零退出并
  保留诊断报告；默认 `down -v` 回收演练资源。`backup.sh drill` 明确标注
  `drill_type=file-verification-only` 并指向 restore-drill.sh。
- `backup.sh create` / `restore-drill.sh` 输出 Prometheus textfile 指标
  （`noj_backup_last_success_unix_time`、`noj_restore_drill_last_success_unix_time`），
  供 node_exporter textfile collector 采集。
- `deploy/monitoring/noj-alerts.yml` 新增 `NojCoreScrapeDown`、`NojCoreMetricsMissing`、
  `NojJudgeHeartbeatMissing`、`NojApiErrorRateRecent*`（5 分钟滑动窗口）、
  `NojBackup*`、`NojRestoreDrillStale`；`prometheus.yml` 增加 Alertmanager 告警段；
  新增 `alertmanager.yml.example`（envsubst 渲染、凭据不入库）、
  `deploy/monitoring/README.md`、`scripts/deploy/test-alert.sh`（投递演练 +
  恢复通知）。Runbook（observability.md）改为带显式 `{#anchor}` 的小节，每个告警
  注解都能定位到处理步骤。
- release.yml 监听 `published` / `prereleased`，但仅让预发布 Release（或手动触发）进入
  构建门禁；正式镜像 tag 重试时若指向不同构建则拒绝覆盖，CLI 资产上传使用
  `--clobber`；新增 `publish-release` 任务在镜像/CLI/校验资产就绪后将预发布转正。
  `install.sh resolve_latest_ref` 只选择非 draft、非 prerelease 且资产包含
  noj-cli 二进制与 .sha256 的 Release；无可选版本时给出明确提示。

## Alternatives considered

- 恢复演练内置到 backup.sh：会让单一脚本承担编排+验收+报告职责，且 verify.ts 需要
  独立进程入口；拆分脚本 + core 容器内 Deno 验收更清晰。
- 业务验收用 SQL 伪造断言：无法证明 API/judge 链路可用；真实评测改走
  import-bundle + self-test 的官方路径，需 admin 演练用户，通过 SQL 注入到隔离库实现。
- 安装器直接用 `/releases/latest`：该端点排除 prerelease，但无法校验资产就绪；
  仍可能选中资产缺失的版本，故改为列表过滤。
- 只调触发器不改安装器：无法防住"published 直接跳过门禁"的人工操作路径，保留双重过滤。

## Consequences

- 隔离恢复演练依赖宿主机 judge 沙箱 socket 与评测镜像；无 judge 环境可用 `--skip-judge`。
- 备份/演练新鲜度告警依赖 node_exporter textfile collector；未启用时不触发，
  `deploy/monitoring/README.md` 已记录该限制与启用方法。
- 告警投递是否被真实接收仍需人工执行 `test-alert.sh` 并记录演练结果，脚本不能替代确认。
- 发布流程多一步预发布操作；直接 published 会被工作流接收但跳过构建（工作流内显式拒绝）。
