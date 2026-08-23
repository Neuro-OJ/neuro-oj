## Context

当前脚本优先调用 `setsid`，macOS 默认没有该命令时退回 `nohup`。`nohup` 不会创建新的 session/process group，无法可靠托管包含 watcher 子进程的开发任务；同时 PID 文件只记录启动包装进程。

## Goals / Non-Goals

**Goals:**

- 启动命令退出后，开发服务继续运行。
- 停止命令能够停止启动的服务进程组。
- stale PID 文件不会阻塞后续启动或误导状态查询。

**Non-Goals:**

- 不引入常驻守护进程或第三方服务管理器。
- 不改变日志位置、端口或现有命令行接口。

## Decisions

1. 保留 `setsid` 优先路径；没有 `setsid` 时使用系统已有的 `python3` 调用 `os.setsid()` 后 `exec` 目标命令。该方式在 macOS 上创建真正的独立 session，避免依赖额外 Homebrew 工具。
2. 为独立 session 保存 PGID。停止时优先向 PGID 发送信号，兼容 `deno task` 派生的 watcher；没有 PGID 元数据时保留旧的 PID 停止回退。
3. `read_pid` 发现 PID 不存在时删除 PID/PGID 文件，避免旧记录造成“已运行”或无法启动。

## Risks / Trade-offs

- [Risk] Python3 不可用时仍只能使用 `nohup`。→ 保留现有回退，并在常见 macOS/Deno 开发环境使用 Python3 独立会话路径。
- [Risk] 进程组信号范围过大。→ 仅使用本次启动记录的数值 PGID，并且仅在独立会话路径成功记录 PGID 时按组停止。
