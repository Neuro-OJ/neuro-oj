## Purpose

确保本地开发编排启动的服务不会因启动命令结束而意外退出，并让状态、启动和停止操作准确反映实际进程生命周期。

## ADDED Requirements

### Requirement: 开发服务必须脱离启动终端运行

开发编排工具启动服务后 MUST 将服务及其 watcher 子进程置于独立会话中，使启动命令返回后服务仍可继续运行。

#### Scenario: macOS 没有 setsid

- **WHEN** 在没有 `setsid` 但有 `python3` 的 macOS 环境执行 `start core`
- **THEN** noj-core 在启动命令返回后继续运行，并可通过健康检查访问

#### Scenario: 服务启动失败

- **WHEN** 后端进程在健康检查前退出
- **THEN** 启动命令返回失败，并保留日志用于诊断

### Requirement: 停止操作必须清理服务进程组

开发编排工具 MUST 保存独立会话的进程组信息；停止服务时应优先终止该进程组，确保 task 包装进程和 watcher 子进程一起退出。

#### Scenario: 停止带 watcher 的开发服务

- **WHEN** 执行 `stop core` 或 `stop ui`
- **THEN** 对应服务进程及其 watcher 均退出，PID 元数据被清理

### Requirement: 失效 PID 不得污染状态

当 PID 文件中的进程不存在时，状态查询 MUST 自动删除失效 PID 及其进程组元数据，并将服务报告为未运行。

#### Scenario: 旧 PID 文件

- **WHEN** 服务进程已退出但 `.pid` 文件仍存在
- **THEN** `status` 报告未运行并清理失效元数据，后续 `start` 可以正常启动
