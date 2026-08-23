## Why

在 macOS 上通常没有 `setsid`，`devtool.sh` 的后台启动逻辑会退化为普通后台进程。启动命令结束或终端会话关闭后，noj-core、noj-ui 和 noj-judge 可能收到会话结束信号并退出，导致服务看似启动成功但无法持续运行。

## What Changes

- 为开发服务启动增加跨平台的 `nohup` 后备方案。
- 启动后台进程时将标准输入重定向到 `/dev/null`，并继续将标准输出和错误输出写入现有日志文件。
- 修正 `pipefail` 与 `grep -q` 组合导致的 Docker 基础设施状态误判。
- 保持现有 PID 文件、状态检查、停止命令和 Linux `setsid` 路径不变。

## Capabilities

### New Capabilities

不适用：这是纯本地开发工具修复，不引入业务能力或运行时 API。

### Modified Capabilities

不适用：不改变产品需求或服务端运行时协议。

## Impact

- 受影响文件：`scripts/dev/devtool.sh`。
- 影响本地开发服务的生命周期管理；不修改生产代码、数据库、API 或第三方依赖。
- 需要验证启动脚本语法，以及服务在启动命令返回后仍保持运行。
