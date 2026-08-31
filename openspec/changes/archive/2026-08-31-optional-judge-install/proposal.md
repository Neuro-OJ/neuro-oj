## Why

NOJ 的前后端和基础服务可以在没有本机 Judge 的情况下先完成部署，但当前生产配置向导始终要求 Judge Docker socket，导致没有评测机的用户无法先使用网站。安装时明确询问是否部署 Judge，可以让基础站点和评测节点按需分开部署。

## What Changes

- 在首次生产配置向导中询问是否同时部署 Judge，默认安装，用户可以选择跳过。
- 跳过 Judge 时不要求专用 Docker socket，不启动或拉取 Judge Worker 镜像。
- 使用 Compose profile 管理 Judge 服务，避免跳过时影响 core、ui、Redis、PostgreSQL 和 LLM Gateway。
- 已有生产配置默认保持 Judge 启用，避免升级改变现有部署行为；用户可重新配置以停用或启用。
- 更新配置模板、部署提示、生产文档和自动化测试，并说明后续启用 Judge 的方式。

## Capabilities

### New Capabilities

- `optional-judge-install`: 首次安装可选择是否部署 Judge，并保证跳过时不触发 Judge 的依赖检查和服务启动。

### Modified Capabilities

- `production-deployment`: 生产安装和生命周期命令根据 Judge 选择启用或跳过 Judge 服务。

## Impact

- 修改 `scripts/deploy/deploy.sh`、`docker-compose.prod.yml`、`.env.prod.example` 和生产部署文档。
- 增加 `JUDGE_ENABLED` 配置项及配置向导分支。
- 不改变 Judge 消息协议、Redis 队列或已有用户权限；已有配置缺少该字段时按启用处理以保持兼容。
