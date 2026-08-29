# 独立 Judge 服务器面板兼容

## ADDED Requirements

### Requirement: 面板检测与覆盖

独立 Judge 部署脚本 MUST 支持 `--panel auto|baota|none`，默认使用 `auto`。在 `auto` 模式下，脚本 MUST 在不修改系统的前提下检测宝塔；用户 MUST 能使用 `baota` 强制显示宝塔提示，或使用 `none` 关闭检测。

#### Scenario: 自动识别宝塔

- **WHEN** 用户运行 `install-env`、`install` 或 `check`，且检测到宝塔
- **THEN** 脚本 MUST 输出宝塔兼容模式提示，并继续执行标准环境检查
- **AND** 脚本 MUST NOT 调用宝塔 API 或修改面板配置

#### Scenario: 普通 Linux 环境

- **WHEN** 未检测到宝塔且面板模式为 `auto`
- **THEN** 脚本 MUST 按原有 Linux Docker 流程继续，不得要求用户安装面板

### Requirement: 面板操作边界

面板兼容提示 MUST 说明 Docker 可在面板中确认状态，但部署脚本仍使用标准 Docker/Compose 命令；脚本 MUST 明确不会接管已有容器、站点、反向代理或面板设置。

#### Scenario: 面板管理 Docker

- **WHEN** 宝塔模式下 Docker 和 Compose 可用
- **THEN** 脚本 MUST 允许继续部署，并提示用户可在宝塔 Docker 页面查看 Redis/Judge 容器

### Requirement: Judge 安全约束保持不变

面板模式 MUST 保留专用 rootless Docker socket 要求，并 MUST 拒绝 `/run/docker.sock`、`/var/run/docker.sock` 或其等价共享 socket。

#### Scenario: 误选共享 socket

- **WHEN** 用户在面板模式下提供共享 Docker socket
- **THEN** 脚本 MUST 在启动容器前失败，并给出专用 rootless socket 指引
