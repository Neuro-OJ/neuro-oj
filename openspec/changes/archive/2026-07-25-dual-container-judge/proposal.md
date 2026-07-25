# 双容器 Evaluator/Solution 评测运行时

## Why

NOJ 当前的评测模型把支持包、`evaluate.py`、用户代码塞入同一个 Docker 容器、同一个 Python 进程，承载 LMCC 类题目时存在以下安全与可扩展性缺陷：

- `evaluate.py` 与用户代码共享文件系统，理论上可被覆盖、伪造模块、污染 `sys.path`。
- 真实 LMCC 题目常用 `evaluate.py` 直接 `import submission` 并调用其中函数，但这种同进程调用把可信评测逻辑放在不可信进程里。
- 部分 LMCC 题目未来可能需要受控能力（内网 API、模型服务、隐藏数据接口），仅靠 `network_mode: none` 不能解决 Solution 受控访问能力的需求。
- NOJ 需要定义自己的安全调用语义，不优先兼容 LMCC 官方样例的同进程 import 方式。

issue #118 明确要求把单容器拆成双容器：**Evaluator（可信）+ Solution（不可信）**，并定义 `noj_evaluator_sdk` / `noj_solution_sdk` 的调用语义，使其迈上生产可用阶段。

## What Changes

- **双容器编排**：noj-judge 按题一次任务启动 Evaluator + Solution 两个容器；Solution 容器默认 `network_mode: none`、不挂支持包、不读取 Evaluator 环境变量、不共享进程。
- **NDJSON RPC 协议**：Solution Host 通过 stdin/stdout 收发 NDJSON 帧；Evaluator SDK 通过 stdout NDJSON + `---RESULT---` 标记与 judge 通信；judge 充当中继转发。
- **SDK 双包**：`noj_evaluator_sdk`（SolutionRunner.call / result.accept/wrong_answer）+ `noj_solution_sdk`（register(fn)）；同步构建默认 Docker 镜像 `noj-evaluator-python` / `noj-solution-python`。
- **持久化 Host**：一次评测启动一个 Solution Host；多次 `runner.call()` 复用同一 Host；提供 `runner.restart()` 重置；明确不实现 `isolate_per_call`。
- **协议安全**：仅允许 7 种基本类型（None / bool / int / float / str / bytes / list / dict），禁止 pickle / cloudpickle / 运行时对象；异常 trace 路径清洗。
- **错误码枚举**：Timeout / NotFound / Exception / SystemError / Rejected 五种错误码。
- **运行时配置入库**：题目表新增 `runtime_config JSONB NULL`；admin UI 提供 Evaluator / Solution 分别配置块；submissions service 按配置选择评测路径。
- **镜像 kind 分类**：`judge_images` 表新增 `kind` 字段（`'evaluator' | 'solution'`），取代 image 名前缀的脆性约定；`get_image_allowlist` RPC 返回结构升级。
- **Evaluator 网络默认禁开**：第一阶段 `runtime_config.evaluator.network` 仅允许 `'none'`；需要网络能力的题目留待 Capability Service（后续阶段）。
- **配套安全测试**：覆盖 evaluate.py 覆盖 / 模块 shadowing / 隐藏文件读取 / 网络访问 / fd 泄露 / trace 路径泄露 / 镜像 kind 错配等。
- **审计日志**：admin 设置/清空 `runtime_config` 记录 `action=problems.runtime_config_changed`。

## Capabilities

### New Capabilities

- `problem-runtime-config`: 题目运行时配置（runtime_config）的 DB 列、admin API、调度语义、向后兼容路径。

### Modified Capabilities

- `judge-worker`: 扩展 dual 模式协议、错误码、时间层级关系、清理契约（RAII）；新增 12 条 dual 测试场景。
- `judge-image-whitelist`: `judge_images` 表新增 `kind` 字段；admin 配置校验；`get_image_allowlist` RPC 返回结构升级。

## Impact

- `noj-core`:
  - Drizzle 迁移：0017（`problems.runtime_config` 列 + CHECK 约束）、0018（`judge_images.kind` 列）
  - admin 题目 CRUD API 接受 `runtime_config`
  - admin UI 题目编辑表单增加 runtime 配置块（含镜像 kind 下拉）
  - submissions service 任务分流（含 SELECT FOR UPDATE 锁）
  - `judge_images` 表的 admin API 升级（kind 必填）
  - `get_image_allowlist` RPC 处理器返回结构升级
- `noj-judge`:
  - `src/types.rs`: JudgeTask 新增 `mode` / `runtime_config` 字段
  - 新模块 `dual/`: 双容器编排、NDJSON 解析、消息转发、清理
  - 新模块 `sdk/evaluator/` 与 `sdk/solution/`: Python SDK
  - 新模块 `docker/evaluator-python/` 与 `docker/solution-python/`: 镜像 Dockerfile
  - 新增脚本 `scripts/build-sdk-images.sh`
  - 新增测试 `tests/e2e_dual_container.rs`（12 条场景）
- `noj-tests/e2e/`:
  - 新增 `08_dual_container_judge.test.ts`（含 image 错配回归）
- 镜像仓库: 新增 `noj-evaluator-python:dev`、`noj-solution-python:dev`
- CI 影响: PR-B 增加镜像构建 ~1-2 分钟；PR-A2 增加 Docker E2E ~3-5 分钟

## Out of Scope

- 支持包内 Manifest
- LMCC 官方样例的 `import submission` 同进程语义兼容
- `isolate_per_call`（每次调用独立隔离进程）
- Solution → Evaluator 反向调用
- `pickle` / `cloudpickle` 跨进程对象传输
- 持久化对象存储（artifact descriptor 后续扩展）
- Capability Service（Evaluator 受控访问能力的独立服务）
- Evaluator 网络访问（`network: 'default'` 第一阶段硬编码禁用）
- 非 Python Solution 镜像（v1 仅 Python）
- Solution 容器状态重置后复用（v1 不复用）