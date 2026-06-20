## Why

noj-judge 的评测流程（Docker 沙箱执行、时间/内存限制、支持包注入、结果解析）是 Neuro OJ 的核心链路，但完全没有集成测试覆盖。当前 41 个单元测试全部为纯函数测试，从未真正启动 Docker 容器或连接 Redis。关键风险包括：Docker API 交互不可靠、资源限制实际不生效、端到端链路在组合时断裂。

## What Changes

- **新增 `noj-judge/tests/e2e/` 集成测试套件**：使用真实 Docker daemon 验证容器创建/执行/日志捕获/资源限制
- **新增测试用 Docker 镜像**：轻量级 `noj-judge-test-runner` 镜像，专用于 CI 集成测试
- **新增 `docker-compose.e2e.yml`**：编排全链路 E2E 测试所需的所有服务（Redis + PostgreSQL + noj-judge + Docker-in-Docker）
- **新增 CI workflow job**：在独立 runner 上运行 E2E 测试，不阻塞主 CI
- **补充单元测试**：为 `run_in_container()`、`ensure_image_local()`、`mq.rs` 添加 mock 辅助的单元测试
- **补充 noj-core 侧集成测试**：验证 `createSubmission` → MQ → `saveEvaluationResult` 的完整状态流转

## Capabilities

### New Capabilities

- `judge-integration-test`: noj-judge 集成测试能力——使用真实 Docker daemon 验证沙箱执行、资源限制、支持包注入、超时/OOM 行为
- `judge-e2e-test`: 全链路 E2E 测试能力——从提交 API 到评测结果持久化的完整流程验证

### Modified Capabilities

- `judge-worker`: 扩展 spec 中的测试场景定义，补充异常路径和边界条件
- `docker-sandbox`: 扩展 spec 中的资源限制场景，补充具体验证指标

## Impact

- **noj-judge**: 新增 `tests/e2e/` 目录、新的测试依赖（`serde_json` 已存在）、测试用 Dockerfile
- **CI**: 新增 E2E job（需要 Docker 服务）、新增 docker-compose 编排文件
- **测试基础设施**: 新增 `.env.e2e` 配置模板、测试辅助工具模块
- **构建系统**: 无需修改 Cargo.toml products（tests 目录自动编译）
