# 安全模型

- 认证：JWT HS256，HTTP-only Cookie，24h 过期。
- 密码：bcrypt cost 12，最小 8 位含大小写与数字。
- 容器安全：cap_drop ALL、no-new-privileges、network_mode none、ipc_mode none、pids_limit 256。
- ZIP 安全：拒绝路径穿越、条目数 ≤ 1000、单文件 ≤ 64 MiB、总解压 ≤ 512 MiB。
- 日志安全：生产环境 UUID 截断、score 隐藏、DB 密码脱敏。

详细安全模型见仓库根目录 `AGENTS.md`。
