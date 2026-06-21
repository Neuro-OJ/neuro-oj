## Why

noj-judge 目前仅有骨架代码（连接 Redis + PING），评测链路在 `pushJudgeTask`
之后完全断裂——任务入队后无人消费，结果无法返回 noj-core
持久化。用户在提交代码后永远看不到评测结果。实现基础评测功能是打通端到端
MVP（注册 → 做题 → 提交 → 查看结果）的关键一步。

## What Changes

- 实现 noj-judge（Rust）的完整评测 Worker：Redis MQ 消费者、Docker
  沙箱管理、评测编排、结果发布
- 在 noj-core 新增结果消费者（BRPOP 方式），将评测结果持久化到
  `evaluation_results` 表
- 构建 `noj-judge-python` Docker 镜像，作为 Python 3 评测的运行环境
- 定义通用 `CaseResult` 格式，规范化 evaluate.py 的用例级输出
- **BREAKING**: 结果投递机制从 PUBLISH（pub/sub）改为 LPUSH（列表），队列 key 从
  `noj:judge:results:{submissionId}` 改为 `noj:judge:results`

## Capabilities

### New Capabilities

- `judge-worker`: noj-judge Rust Worker — 从 Redis MQ 拉取评测任务，在 Docker
  容器中执行评测，解析结果并返回
- `docker-sandbox`: Docker 沙箱管理 —
  创建隔离容器、注入代码、设置资源限制、捕获输出、清理残留

### Modified Capabilities

- `redis-message-queue`: 结果投递从 PUBLISH 改为 LPUSH/BRPOP
  模式，结果队列名统一为 `noj:judge:results`

## Impact

- **noj-judge** (`Cargo.toml`, `src/`): 新增 bollard/serde/anyhow/tracing
  依赖，新建 mq/sandbox/judge 模块
- **noj-core** (`src/mq/`, `src/services/submissions.ts`): 新增 result
  consumer，修改 createSubmission 状态流转
- **Docker**: 新增 `noj-judge/docker/python/Dockerfile`，构建评测镜像
- **CI**: judge-check 工作流无需变更（已包含 cargo test/build/clippy）
