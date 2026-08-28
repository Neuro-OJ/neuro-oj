## MODIFIED Requirements

### Requirement: 全栈 Docker Compose 编排测试

系统 SHALL 提供 Docker Compose 编排文件，支持一键启动完整评测栈执行 E2E 测试；在本地启动评测栈时，所使用的 Evaluator 与 Solution SDK 镜像 SHALL 与当前工作树同步构建，避免复用过期镜像。

#### Scenario: 一键启动所有服务

- **WHEN** 执行 `docker compose -f docker-compose.e2e.yml up -d`
- **THEN** noj-core、PostgreSQL、Redis、noj-judge 全部启动并可用
- **THEN** noj-core API 在配置端口上响应健康检查请求
- **THEN** 本地 E2E 使用的 Evaluator 与 Solution SDK 镜像已从当前工作树构建

#### Scenario: 全栈测试门控

- **WHEN** 环境变量 `NOJ_RUN_E2E=1` 未设置
- **THEN** `deno task test` 跳过所有全栈 E2E 测试
- **WHEN** 环境变量 `NOJ_RUN_E2E=1` 已设置
- **THEN** `deno task test` 启动测试栈并执行全链路测试

#### Scenario: SDK 镜像构建失败

- **WHEN** 本地 E2E 启动阶段任一 SDK 镜像构建失败
- **THEN** 启动脚本以非零状态退出
- **THEN** 不继续启动或报告测试环境就绪
