# Agent Note: 跨模块验收夹具定位隔离运行栈

Status: implemented

## Problem

完整跨模块回归中的恢复、消息容错和存储故障夹具仍写死旧 E2E
容器名。在新的正式镜像隔离项目执行，会重启或向原运行栈写入消息；存储故障夹具也只支持
local 文件，无法验证本次 S3 部署。

## Decision

- outbox 恢复测试从 `E2E_CORE_CONTAINER`、`E2E_JUDGE_CONTAINER` 和
  `E2E_GATEWAY_CONTAINER` 定位进程，保留标准 E2E 默认名称。
- 管道无效消息测试读取 `E2E_REDIS_CONTAINER` 和可选 `E2E_REDIS_PASSWORD`，不向旧
  Redis 写入夹具消息。
- 存储故障测试根据当前 `STORAGE_PROVIDER` 删除本次新建题目的专属支持包。 S3
  分支使用 `E2E_MINIO_CONTAINER`、桶和测试 MinIO
  凭据，核实对象存在、删除成功和删除后不存在；local 分支继续定位 core
  的文件。执行失败不能跳过故障断言。
- 不更改业务源码、测试 ignore 或运行中的原项目；镜像与网络等临时验收配置保留在
  `/tmp`。

## Alternatives considered

- 复用旧容器名称会污染原验收与备份恢复项目，拒绝。
- 跳过 S3 故障场景或仅检查删除命令退出码，不能证明故障已注入，拒绝。
- 将整套新栈切回 local 会丢失生产 S3 行为验收，本次保留真实 S3。

## Consequences

标准 E2E 名称仍为默认值，新项目通过显式环境变量运行。新栈使用正式编译入口、独立
PostgreSQL、Redis、MinIO 和网络；mock 邮件及主机 Docker daemon
的边界如实记录，不宣称付费邮件或 rootless 生产验收。

首轮真实跨模块执行有 49 项通过、6 项失败，暴露临时网络切换的 Gateway
服务别名缺失、Compose 临时 Judge
名称及管理员索引前置缺失。实际修正这些前置后，标准
`deno task test:domain cross-domain` 完整运行结果为 55 项通过、10 个步骤通过、
无失败、无忽略，耗时 1 分 13 秒。正常进度样本为 1309 毫秒；core PID 从 823511
变为 923270，重启后两个持久积压事件自行恢复，测得 2288 毫秒， Judge 和 Gateway
保持原进程。

本轮 S3 故障注入、完整五题型教学和两学校 LLM 持久用量链路均实际通过。 默认域
main:1001 经正式 CLI 导入并发布，采用新 SDK 标签；其他旧题包部分仍使用
未带标签的 SDK，不能据本轮旧场景宣称全部采用新 SDK。新输入模式与模型治理浏览器
场景独立指定 `20261013-main-final`，其结果另记。
