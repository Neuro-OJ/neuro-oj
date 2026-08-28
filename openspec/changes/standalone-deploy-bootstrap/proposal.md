## Why

当前用户需要先获取整个仓库才能使用生产部署脚本，首次部署仍包含 `git clone`、进入目录等额外步骤。提供一个可单独下载的 bootstrap 脚本，可以让 Linux 用户从固定仓库版本开始部署，同时保留现有生产部署流程和安全边界。

## What Changes

- 新增可独立下载执行的 Linux bootstrap 脚本。
- 脚本从 GitHub 仓库下载指定 ref 的源码归档，完成安全解压后调用现有生产部署入口。
- 支持自定义仓库、版本 ref、安装目录和下载工具，并在下载失败或目标目录不安全时返回非零状态。
- 默认使用可复现的固定 ref，不静默覆盖已有配置或已部署目录。
- 补充 bootstrap 使用文档和不依赖网络/真实 Docker 的 shell 测试。

## Capabilities

### New Capabilities

- `standalone-deploy-bootstrap`: 面向 Linux 用户的单文件下载、获取项目源码并启动生产部署流程。

### Modified Capabilities

- 无。

## Impact

- 新增 `scripts/deploy/install.sh` 及其 shell 测试。
- 更新生产部署文档和脚本说明。
- 依赖 Linux 常见的 Bash、`curl` 或 `wget`、`tar`；实际服务部署仍依赖 Docker Compose v2。
- 不改变现有 `docker-compose.prod.yml`、数据卷、生产环境变量或 `deploy.sh` 的生命周期职责。
