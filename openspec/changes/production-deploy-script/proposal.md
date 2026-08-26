## Why

Neuro OJ 当前的开发启动脚本不能直接满足生产部署需求，用户仍需手工完成环境初始化、数据库迁移、服务启动和健康检查，首次部署容易遗漏关键步骤或使用不安全的默认配置。现在补充统一的生产部署入口，可以降低安装门槛并为后续升级、备份和故障排查提供稳定流程。

## What Changes

- 新增面向用户的生产部署脚本，支持首次安装、启动、停止、升级、状态查看和日志查看。
- 自动检查 Docker/Compose、必要资源和端口，并以可读方式报告问题。
- 初始化生产环境配置和随机密钥，保护已有环境文件，不静默覆盖用户配置。
- 编排基础设施和应用服务，执行数据库迁移、系统初始化、管理员初始化和题目支持包构建/导入。
- 支持官方镜像、国内镜像或代理配置，并提供健康检查和失败诊断。
- 将 LLM Gateway 的生产配置纳入部署检查。
- 补充生产部署文档、环境模板和脚本 smoke test。
- 不改变现有开发脚本和 Docker Compose 的服务职责；部署脚本作为生产流程封装层。

## Capabilities

### New Capabilities

- `production-deployment`: 面向用户的 Neuro OJ 生产环境安装、启动、升级、检查和停止流程。

### Modified Capabilities

- 无。

## Impact

- 新增 `scripts/deploy/` 生产部署脚本及其测试/辅助文件。
- 可能补充生产 Compose 配置、环境变量模板和部署文档，但不重新设计现有服务拓扑。
- 涉及 Docker、Docker Compose、PostgreSQL、Redis、MinIO、noj-core、noj-ui、noj-judge 和可选的 noj-llm-gateway。
- 不新增运行时依赖；脚本默认使用 Bash、Docker Compose 和项目现有管理命令。
