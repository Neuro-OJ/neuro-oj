## ADDED Requirements

### Requirement: CI 冒烟测试 job

CI SHALL 提供 `core-smoke` job 作为快速反馈路径，不启动 noj-judge。

#### Scenario: 冒烟测试触发条件

- **WHEN** PR 提交或推送到 main 分支
- **THEN** `core-smoke` job 启动
- **THEN** 启动 PostgreSQL 和 Redis 服务容器
- **THEN** 运行 noj-core 迁移
- **THEN** 执行冒烟测试脚本

#### Scenario: 核心 API 可达性验证

- **WHEN** noj-core 服务就绪
- **THEN** `GET /api/v1/health` 返回 200
- **THEN** `POST /api/v1/auth/register` 返回 201
- **THEN** `POST /api/v1/auth/login` 返回 200
- **THEN** `GET /api/v1/problems` 返回 200

#### Scenario: 测试门控

- **WHEN** `core-smoke` job 失败
- **THEN** PR 标记为检查失败
- **THEN** 提供失败日志供调试

#### Scenario: 执行时间

- **WHEN** `core-smoke` job 运行
- **THEN** 完成时间不超过 3 分钟
- **THEN** 不启动 Docker 容器评测（no judge）

### Requirement: 冒烟测试文件

测试 SHALL 提供独立的冒烟测试脚本，集中管理核心端点 URL。

#### Scenario: 冒烟测试脚本

- **WHEN** 执行 `deno task test:smoke`
- **THEN** 验证所有核心 API 端点返回预期状态码
- **THEN** 不依赖 `NOJ_RUN_E2E=1`（始终运行）
- **THEN** 不执行评测相关测试（快速）

#### Scenario: 端点列表集中管理

- **WHEN** 新增核心路由
- **THEN** 开发者将新端点加入 `SMOKE_ENDPOINTS` 常量数组
- **THEN** 冒烟测试自动覆盖该端点
