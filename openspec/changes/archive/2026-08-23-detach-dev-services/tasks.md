## 1. 后台进程托管

- [x] 1.1 修改 `scripts/dev/devtool.sh` 的 `spawn_target`，在没有 `setsid` 时使用 `nohup`，并在所有后台启动路径将标准输入重定向到 `/dev/null`；同时修正 `pipefail` 下 Docker 状态检测的 `grep -q` 误判；通过 `bash -n scripts/dev/devtool.sh` 验证脚本语法。
- [x] 1.2 保持现有 PID 文件、日志重定向和停止流程不变；通过 `devtool.sh start` 后命令返回仍能读取存活 PID，且 `devtool.sh status` 显示 core/ui/judge 运行。

## 2. 启动验证

- [x] 2.1 启动全部开发模块并验证 core `/health` 返回 healthy、ui 端口 3000 可访问、judge 进程仍存活；记录 `devtool.sh status` 结果。
- [x] 2.2 使用 OpenSpec 严格校验 `detach-dev-services`，并运行 `git diff --check` 确认变更无格式问题。
