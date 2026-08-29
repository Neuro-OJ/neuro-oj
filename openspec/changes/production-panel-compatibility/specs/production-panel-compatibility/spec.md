# 前后端生产部署服务器面板兼容

## ADDED Requirements

### Requirement: 前后端脚本支持面板模式

前后端 bootstrap 脚本和生产部署脚本 MUST 支持 `--panel auto|baota|none`，默认使用 `auto`。bootstrap 脚本 MUST 将 `--` 后的面板参数传递给生产部署脚本。

#### Scenario: 自动检测宝塔

- **WHEN** 用户运行前后端 `check` 或 `install`，且检测到宝塔
- **THEN** 脚本 MUST 输出宝塔兼容提示并继续标准 Docker/Compose 检查
- **AND** 脚本 MUST NOT 调用宝塔 API 或修改面板配置

#### Scenario: 覆盖面板检测

- **WHEN** 用户指定 `--panel baota`
- **THEN** 脚本 MUST 输出宝塔兼容提示，即使未检测到默认安装路径
- **WHEN** 用户指定 `--panel none`
- **THEN** 脚本 MUST 不输出宝塔兼容提示并按普通 Linux 流程继续

### Requirement: 面板部署引导

宝塔兼容提示 MUST 说明脚本使用标准 Docker/Compose，前后端 Compose 自带 Nginx，用户应在面板中将域名反向代理到 `127.0.0.1:NGINX_PORT`，并确认端口未被其他服务占用。

#### Scenario: 面板反向代理

- **WHEN** 宝塔模式下环境检查通过
- **THEN** 脚本 MUST 提示用户在宝塔中配置域名和反向代理
- **AND** 脚本 MUST 提示默认目标端口为 `8080`，并说明 `NGINX_PORT` 可修改

### Requirement: 生产安全边界不变

面板模式 MUST 保留生产配置、镜像签名和 Judge 隔离 Docker socket 校验；脚本 MUST 拒绝共享 Docker socket。

#### Scenario: 面板环境误用共享 socket

- **WHEN** 用户在宝塔模式下提供 `/run/docker.sock` 或 `/var/run/docker.sock`
- **THEN** 生产部署 MUST 在启动服务前失败
- **AND** 错误信息 MUST 指向 Judge 专用 rootless Docker socket

### Requirement: 管道一键安装支持交互配置

前后端 bootstrap 通过 `curl | bash -s` 执行时 MUST 能在存在 `/dev/tty` 的 Linux 终端中继续交互式读取配置；如果没有可用终端，脚本 MUST 保留当前的非交互失败提示。

#### Scenario: 从 curl 管道执行

- **WHEN** 用户通过一行 `curl | bash -s` 命令启动安装，且服务器存在可读写的 `/dev/tty`
- **THEN** 脚本 MUST 从终端读取 `NOJ_VERSION`、域名、邮件、管理员和 Judge socket 配置
- **AND** 脚本 MUST 不把管道中的脚本内容当作配置输入

#### Scenario: 上次安装中断后重试

- **WHEN** `.env.prod` 已由此前一次安装创建但仍包含占位配置，且用户重新在终端执行安装
- **THEN** 脚本 MUST 保留已生成的随机密钥并继续引导补齐配置
