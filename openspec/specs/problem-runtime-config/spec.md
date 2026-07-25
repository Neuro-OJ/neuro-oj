## Purpose

定义 Neuro OJ 题目运行时配置（runtime_config）规范。runtime_config 是题目
JSONB 列，描述双容器评测模式下 Evaluator 与 Solution 各自运行时参数，
替代单容器时代的 `judge_image` / `judge_command` 字段。

## Requirements

### Requirement: 题目运行时配置（runtime_config）

系统 SHALL 在 `problems` 表中存储 JSONB 格式的 `runtime_config`，用于描述双容器
评测模式下的 Evaluator 与 Solution 各自运行时参数，且 runtime_config 为必填。

#### Scenario: problems 表新增 runtime_config 列（NOT NULL）

- **WHEN** Drizzle 迁移 `0017_problem_runtime_config.sql` 与 `0020_runtime_config_not_null.sql` 全部执行
- **THEN** `problems` 表含 `runtime_config JSONB NOT NULL` 列
- **THEN** 附加 CHECK 约束：`jsonb_typeof(runtime_config) = 'object'`

#### Scenario: RuntimeConfig 结构

- **WHEN** admin 设置 `runtime_config` 字段
- **THEN** 必填结构：
  - `evaluator.image: string`（必填，Docker 镜像名）
  - `evaluator.command: string`（必填，如 `python3 /workspace/evaluate.py`）
  - `evaluator.time_limit_ms: number`（必填，> 0）
  - `evaluator.memory_limit_mb: number`（必填，> 0）
  - `solution.image: string`（必填）
  - `solution.entry: string`（必填，如 `solution.py`）
  - `solution.call_timeout_ms: number`（必填，> 0）
  - `solution.memory_limit_mb: number`（必填，> 0）

#### Scenario: runtime_config 缺字段校验失败

- **WHEN** admin 提交题目创建/更新请求，`runtime_config` 缺失任一必填字段
- **THEN** API 返回 HTTP 400，错误信息明确指出缺失字段

### Requirement: admin API 处理 runtime_config

系统 SHALL 允许 admin 通过题目 CRUD API 设置 / 更新 `runtime_config` 字段。

#### Scenario: admin 创建题目时设置 runtime_config

- **WHEN** admin 发送 `POST /api/v1/admin/problems`，payload 含合法 `runtime_config`
- **THEN** 系统校验：结构合法 + evaluator/solution image 在白名单中 + kind 匹配
- **THEN** 校验通过则创建题目，runtime_config 写入 JSONB 列
- **WHEN** 任何校验失败
- **THEN** 返回 HTTP 400 + 明确错误（image_not_allowlisted / kind_mismatch / invalid_structure）

#### Scenario: admin 更新题目时设置 runtime_config

- **WHEN** admin 发送 `PUT /api/v1/admin/problems/:id`，payload 含 `runtime_config`
- **THEN** 系统执行与创建相同的校验
- **THEN** 校验通过则更新 runtime_config 字段
- **THEN** 记录审计日志 `action=problems.runtime_config_changed`

#### Scenario: 普通用户创建题目不允许配置 runtime_config

- **WHEN** 普通用户（role='user'）发送 `POST /api/v1/problems`，payload 含 `runtime_config`
- **THEN** 系统返回 HTTP 403，提示仅 admin 可配置双容器评测

### Requirement: 提交流程按 runtime_config 调度

系统 SHALL 在 submissions service 推 MQ 前读取题目 `runtime_config`（必填），构造
dual 模式 JudgeTask。

#### Scenario: 题目 runtime_config 必填走双容器

- **WHEN** 题目 `runtime_config IS NOT NULL`（必然，因 NOT NULL 约束）
- **THEN** submissions service 构造 `JudgeTask { runtime_config, ... }`
- **THEN** 推 `noj:judge:queue`，judge 端按 dual 路径执行

#### Scenario: 题目行级锁避免并发修改

- **WHEN** submissions service 准备推 MQ
- **THEN** 先以 `SELECT ... FOR UPDATE`（或基于 `updated_at` 的乐观锁）锁住题目行
- **THEN** 在同一事务内读取 `runtime_config` 并构造 task
- **WHEN** admin 在此期间尝试更新题目
- **THEN** admin 更新阻塞直到 submissions service 提交
- **THEN** 避免 admin 修改 runtime_config 后提交仍走旧配置的竞态

#### Scenario: 推 MQ 前再校验白名单

- **WHEN** submissions service 构造完 task 准备推 MQ
- **THEN** 再次读取 `judge_images` 白名单确认 `runtime_config.evaluator.image` 与 `runtime_config.solution.image` 仍可用且 kind 匹配
- **WHEN** 镜像被下架或 kind 被改
- **THEN** 返回 `image_not_allowlisted` 错误，submission 标记为 error

### Requirement: 导出导入兼容

系统 SHALL 在题目导出/导入时支持 `runtime_config` 字段。

#### Scenario: 导出包含 runtime_config

- **WHEN** admin 导出题目
- **THEN** `ExportProblem` 结构包含 `runtime_config: RuntimeConfig`

#### Scenario: 导入新版本文件

- **WHEN** 导入文件 version = '1.0' 且含 `runtime_config`
- **THEN** 解析时校验结构 + 白名单 + kind
- **WHEN** 校验失败
- **THEN** 该题目标记为 failed，reason 包含失败原因
- **THEN** 不影响其他题目的导入

### Requirement: 审计日志

系统 SHALL 记录 admin 对题目 runtime_config 的修改。

#### Scenario: 设置或修改 runtime_config

- **WHEN** admin 创建或更新题目并修改 `runtime_config`
- **THEN** 审计日志出现 `action=problems.runtime_config_changed`
- **THEN** `detail` 包含 `problem_id`、`display_id`、旧值摘要（has_runtime_config: bool）、新值摘要（has_runtime_config: bool）

### Requirement: 公开题目 API 包含 runtime_config

系统 SHALL 在公开题目查询 API 中暴露 `runtime_config` 字段供前端使用。

#### Scenario: GET /problems/:id 返回 runtime_config

- **WHEN** 用户查询题目详情
- **THEN** 响应体包含 `runtime_config: RuntimeConfig`

#### Scenario: 列表 API 不暴露 runtime_config

- **WHEN** 用户查询题目列表
- **THEN** 列表项不包含 `runtime_config` 字段（避免列表响应过大）
- **THEN** 仅返回基础元数据（id / display_id / title / difficulty 等）