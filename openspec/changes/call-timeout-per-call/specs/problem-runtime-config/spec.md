## MODIFIED Requirements

### Requirement: 题目运行时配置（runtime_config）

系统 SHALL 在 `problems` 表中存储 JSONB 格式的 `runtime_config`，用于描述双容器评测模式下的 Evaluator 与 Solution 各自运行时参数。

#### Scenario: problems 表 runtime_config 列

- **WHEN** 检查 `problems` 表结构
- **THEN** `runtime_config` 为 JSONB NOT NULL 列（统一双容器模式，无单容器回退）

#### Scenario: RuntimeConfig 结构

- **WHEN** 用户设置 `runtime_config` 字段
- **THEN** 必填结构：
  - `evaluator.image: string`（必填，Docker 镜像名）
  - `evaluator.command: string`（可选，缺省注入默认值 `python3 /workspace/evaluate.py`）
  - `evaluator.time_limit_ms: number`（必填，> 0）
  - `evaluator.memory_limit_mb: number`（必填，> 0）
  - `evaluator.network: object`（可选，缺省视为 `{"enabled": false}`）
  - `solution.image: string`（必填）
  - `solution.entry: string`（必填，如 `solution.py`）
  - `solution.call_timeout_ms: number`（必填，> 0；作为调用级超时的**题目级默认值**，`runner.call(..., timeout_ms)` 可按调用覆盖）
  - `solution.memory_limit_mb: number`（必填，> 0）

#### Scenario: evaluator.command 缺省注入默认值

- **WHEN** 导入统一题目包时 `runtime_config.evaluator.command` 缺省
- **THEN** 系统在落库前注入默认值 `python3 /workspace/evaluate.py`
- **THEN** 落库后的 `runtime_config.evaluator.command` 为非空字符串，结构与既有题目一致

#### Scenario: API 创建/更新路径 command 必填

- **WHEN** 通过题目 CRUD API 创建/更新题目且 `runtime_config.evaluator.command` 缺省
- **THEN** 系统返回 HTTP 400（command 为必填字段；默认值注入仅限统一题目包导入路径）
