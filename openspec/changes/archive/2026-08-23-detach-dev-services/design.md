## Context

`scripts/dev/devtool.sh` 的 `spawn_target` 已在支持 `setsid` 的系统上创建独立会话，但 macOS 当前环境没有该命令，现有后备分支只使用 shell 后台运行。服务进程因此仍可能继承终端生命周期；PID 和日志文件格式已经被 `status`、`stop` 等命令使用，不能改变。

## Goals / Non-Goals

**Goals:**

- 让 macOS 和其他没有 `setsid` 的环境中的开发服务在启动命令返回后继续运行。
- 让后台进程不依赖启动终端的标准输入。
- 保持现有启动顺序、日志位置、PID 文件和停止流程兼容。

**Non-Goals:**

- 不引入新的外部依赖或系统服务管理器。
- 不改变 core、ui、judge 的业务代码和运行参数。
- 不改变 Docker 基础设施的生命周期管理。

## Decisions

### 使用 `nohup` 作为 `setsid` 的跨平台后备

保留 Linux 等环境的 `setsid` 路径；当命令不可用时使用系统自带的 `nohup`。`nohup` 是 macOS 和常见 Unix 环境的基础命令，能够忽略终端关闭时的 `SIGHUP`，比直接后台运行更适合当前脚本的轻量守护需求。

替代方案是强制依赖 `setsid` 或引入 `daemonize` 等第三方工具，但会降低 macOS 可用性或增加安装前置条件。

### 所有后台路径统一重定向标准输入

将标准输入重定向到 `/dev/null`，标准输出和标准错误继续追加到对应日志文件。这样服务不会持有已关闭的终端管道，也不会在终端退出后等待交互输入。

### 保持现有 PID 语义

继续使用 `$!` 写入 `scripts/dev/logs/<target>.pid`。`nohup` 和 `setsid` 都只作为启动包装，实际服务命令和现有状态/停止逻辑不变。

### 避免 `pipefail` 下的状态检测误判

将 Docker 服务状态判断中的 `grep -qE` 改为完整消费输入后再丢弃匹配结果。这样不会因 `grep -q` 提前退出导致上游 `docker compose` 收到 SIGPIPE，从而保证启动、停止和状态命令得到真实的基础设施状态。

## Risks / Trade-offs

- [Risk] `nohup` 只能保证忽略 `SIGHUP`，不能替代完整的系统级服务管理。→ 本变更只面向本地开发，并用端口/健康检查确认启动结果。
- [Risk] 进程异常退出时可能留下旧 PID 文件。→ 现有 `read_pid` 会验证 PID 存活，后续启动会覆盖陈旧 PID 文件；本次不改变该机制。
- [Risk] Docker CLI 输出格式在未来版本变化可能影响文本匹配。→ 保持现有服务名匹配规则，仅修复管道退出状态，不扩大匹配范围。

## Migration Plan

1. 修改 `spawn_target` 的后备启动分支，并为 `setsid` 分支补充标准输入重定向。
2. 使用脚本语法检查和 `devtool.sh start` 验证服务在启动命令结束后仍存活。
3. 用 `devtool.sh status`、8000 健康检查和 3000 端口检查确认运行状态。
4. 如需回滚，恢复 `scripts/dev/devtool.sh` 的单个函数即可，不涉及数据迁移。
