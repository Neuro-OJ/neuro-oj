## Purpose

让没有评测机或暂时不需要代码评测的用户能够先完成 NOJ 网站部署，并在需要时安全启用 Judge 服务。

## ADDED Requirements

### Requirement: 安装时可选择 Judge

生产安装配置向导 MUST 询问用户是否同时部署 Judge；用户选择跳过时 MUST 完成基础网站部署，且 MUST 不要求专用 Judge Docker socket。

#### Scenario: 默认安装 Judge

- **WHEN** 用户在首次生产配置向导中直接确认安装 Judge
- **THEN** 系统 MUST 保存 Judge 启用状态
- **AND** 系统 MUST 校验专用 rootless Docker socket
- **AND** 系统 MUST 启动 Judge Worker

#### Scenario: 跳过安装 Judge

- **WHEN** 用户在配置向导中选择不安装 Judge
- **THEN** 系统 MUST 保存 Judge 关闭状态
- **AND** 系统 MUST 不要求 Judge Docker socket 存在
- **AND** 系统 MUST 启动 core、ui 和基础设施，不启动 Judge Worker
- **AND** 系统 MUST 提示当前部署暂不提供代码评测

#### Scenario: 后续启用 Judge

- **WHEN** 用户补充专用 rootless Docker socket 配置并启用 Judge 后执行启动操作
- **THEN** 系统 MUST 校验 socket 隔离和权限
- **AND** 系统 MUST 启动 Judge Worker

### Requirement: 跳过 Judge 不拉取其镜像

当 Judge 被关闭时，生产生命周期操作 MUST 不启动或拉取 Judge Worker、evaluator 和 solution 运行时镜像。

#### Scenario: 关闭 Judge 时拉取镜像

- **WHEN** 用户执行安装、启动或升级且 Judge 处于关闭状态
- **THEN** 系统 MUST 只操作启用的生产服务镜像
- **AND** 系统 MUST 不把 Judge 服务作为 Compose 启用服务

