## 1. 开发启动编排

- [x] 1.1 在 `start_core` 启动进程前调用既有管理员引导，并保留开发模式不强制首次改密；通过 `bash -n scripts/dev/devtool.sh` 验证语法。

## 2. 验证

- [x] 2.1 在缺失配置管理员的本地开发数据库中执行 `devtool.sh start core`，验证账号被创建且可成功登录。
- [x] 2.2 执行 `openspec validate auto-bootstrap-dev-admin --strict`，验证变更规范。
