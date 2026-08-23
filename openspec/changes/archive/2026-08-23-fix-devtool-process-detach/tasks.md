## 1. 进程托管

- [x] 1.1 为 `spawn_target` 增加 macOS Python 独立会话回退并记录 PGID；通过 shell 语法检查验证
- [x] 1.2 更新停止逻辑按已记录 PGID 清理 task 与 watcher，保留旧 PID 回退；通过脚本静态检查验证
- [x] 1.3 失效 PID 查询时清理 PID/PGID 文件；通过 shell 语法检查验证

## 2. 验证

- [x] 2.1 在可用开发环境执行 start → 等待 → status/health → stop 流程，并确认进程组均退出
- [x] 2.2 运行 OpenSpec 校验并检查变更差异
