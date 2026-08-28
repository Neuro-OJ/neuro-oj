# NOJ 防御模式

本文档记录 NOJ 在生命周期、并发、子进程、文件系统、安全边界上的硬规则。每条规则都来自实际缺陷或安全审计，修改相关代码前先读这里。

## 正交结果独立上报

一个进程可能同时“超时”和“exit 0”（例如捕获了信号）。上报结果时，`timedOut`、`signal`、`exitCode` 必须作为独立字段，不能嵌套在一个标志里，避免调用方把截断的运行误读为成功。

适用：`noj-judge` 结果解析、评测超时/OOM 检测。

## Dispose 必须达到 quiescence

清理/卸载不能只发出 kill/abort 就返回：

- 先关闭 listener / notification 注册，再 kill 子进程/容器。
- 异步等待子进程/容器真正退出（kill → await done）。
- 防止 late completion 在关闭后继续写结果。

适用：`noj-judge` 容器清理、消费者关闭、SSE 订阅退订。

## 回调异常由 dispatcher 兜底

用户/插件提供的 listener 抛错时，不能 reject 外层 Promise，也不能饿死后续 listener。分发循环必须 try/catch 并记录日志。

适用：`noj-core` event-bus 本地监听器、SSE 回调。

## 不给未受信输出 ambient env

spawn 子进程/容器前，必须清理环境变量中的 `*KEY*`、`*SECRET*`、`*TOKEN*`、`*PASSWORD*`，防止凭据泄漏到输出、env 或 spill 文件。

适用：`noj-judge` 容器环境构造、未来 subprocess 能力。

## 临时文件私有随机

临时/溢出文件使用：

- 私有目录（0700）
- 随机文件名
- 独占 owner-only 打开（`wx` / `0600`）

避免可预测路径被 symlink race 利用。

## 删除 link-shaped path 用 lstat + unlink

可能为 symlink / Windows junction 的路径：

1. `lstatSync().isSymbolicLink()` 判断；
2. `unlinkSync()` 只删除链接本身；
3. 不要对未知路径直接递归 `rm`，否则可能跟随链接删到目标。

适用：`noj-core` 本地存储清理、`noj-judge` 文件清理。

## ZIP 安全

- 拒绝 `..` 或 `/` 开头的条目。
- 条目数 ≤ 1000。
- 单文件 ≤ 64 MiB。
- 总解压 ≤ 512 MiB。

适用：支持包解压。

## 容器安全

- `cap_drop ALL`
- `no-new-privileges`
- `network_mode none`
- `ipc_mode none`
- `pids_limit 256`
- `tmpfs /tmp`（256M）

适用：`noj-judge` 沙箱。
