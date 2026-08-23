## Why

`devtool.sh` 在没有 `setsid` 的 macOS 环境下仅使用 `nohup` 启动开发服务。`deno task dev` 还会派生 watcher 子进程，终端退出后进程可能被一起回收，留下失效 PID 文件，造成后端自动退出和状态误报。

## What Changes

- 为 macOS 增加可创建独立会话的后台启动回退路径。
- 记录并清理独立会话对应的进程组，避免只停止 task 包装进程而残留 watcher。
- 读取失效 PID 时自动清理 PID 元数据，保持 `status` 与实际进程一致。

## Capabilities

### New Capabilities

- `devtool-process-lifecycle`: 开发编排工具可靠托管、查询和停止后台服务进程。

### Modified Capabilities

无。

## Impact

- 仅修改 `scripts/dev/devtool.sh` 及其开发工具规范。
- 不改变 noj-core、noj-ui、noj-judge 的业务逻辑或生产部署方式。
