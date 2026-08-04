## Purpose

定义题目双容器评测运行时配置（`runtime_config`）的规范。该 JSONB 字段存储 Evaluator 与 Solution 容器的运行时参数，支持按题目独立配置双容器评测环境。
## Requirements
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
  - `solution.call_timeout_ms: number`（必填，> 0）
  - `solution.memory_limit_mb: number`（必填，> 0）

#### Scenario: evaluator.command 缺省注入默认值

- **WHEN** 导入统一题目包时 `runtime_config.evaluator.command` 缺省
- **THEN** 系统在落库前注入默认值 `python3 /workspace/evaluate.py`
- **THEN** 落库后的 `runtime_config.evaluator.command` 为非空字符串，结构与既有题目一致

#### Scenario: API 创建/更新路径 command 必填

- **WHEN** 通过题目 CRUD API 创建/更新题目且 `runtime_config.evaluator.command` 缺省
- **THEN** 系统返回 HTTP 400（command 为必填字段；默认值注入仅限统一题目包导入路径）

#### Scenario: 显式提供 command

- **WHEN** `runtime_config.evaluator.command` 显式提供（如 `python3 /workspace/evaluator/main.py`）
- **THEN** 系统保留显式值，不做默认注入

### Requirement: admin API 处理 runtime_config

系统 SHALL 允许 admin 通过题目 CRUD API 设置 / 更新 / 清空 `runtime_config` 字段。

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

#### Scenario: admin 尝试清空 runtime_config 被拒

- **WHEN** admin 发送 `PUT /api/v1/admin/problems/:id`，payload 含 `runtime_config: null`
- **THEN** 系统返回 HTTP 400（runtime_config 是必填字段，不可清空；统一双容器模式，无单容器回退路径）

#### Scenario: 普通用户创建 U 型题目可配置双容器

- **WHEN** 普通用户（role='user'）发送 `POST /api/v1/problems`，payload 含 `runtime_config`
- **THEN** 系统按题目类型校验：U 型放行（联网与双容器配置权限与题目创建权限一致，不要求 admin），P 型拒绝（仅 admin 可创建 P 型）
- **THEN** evaluator 联网门禁与创建/编辑权限一致，不单独设限（设计决策：任何人可对自己题目开启 evaluator 联网）

### Requirement: 提交流程统一使用双容器路径

系统 SHALL 在 submissions service 推 MQ 时统一使用双容器模式（`runtime_config` 必填，无单容器路径）。

#### Scenario: 提交走双容器

- **WHEN** 题目存在且 `runtime_config` 非空
- **THEN** submissions service 构造 `JudgeTask { mode: 'dual', runtime_config, ... }`
- **THEN** 推 `noj:judge:queue`，judge 端按 dual 路径执行

#### Scenario: 题目行级锁避免并发修改

- **WHEN** submissions service 准备推 MQ
- **THEN** 先以 `SELECT ... FOR UPDATE`（或基于 `updated_at` 的乐观锁）锁住题目行
- **THEN** 在同一事务内读取 `runtime_config` 并构造 task
- **WHEN** admin 在此期间尝试更新题目
- **THEN** admin 更新阻塞直到 submissions service 提交
- **THEN** 避免 runtime_config 并发修改竞态

#### Scenario: 推 MQ 前再校验白名单

- **WHEN** submissions service 构造完 task 准备推 MQ
- **THEN** 再次读取 `judge_images` 白名单确认 `runtime_config.evaluator.image` 与 `runtime_config.solution.image` 仍可用且 kind 匹配
- **WHEN** 镜像被下架或 kind 被改
- **THEN** 返回 `image_not_allowlisted` 错误，submission 标记为 error

### Requirement: 导出导入兼容

系统 SHALL 在题目导出/导入时支持 `runtime_config` 字段，并对旧版导出文件保持向后兼容。

#### Scenario: 导出包含 runtime_config

- **WHEN** admin 导出题目
- **THEN** `ExportProblem` 结构包含 `runtime_config: RuntimeConfig | null`

#### Scenario: 导入新版本文件

- **WHEN** 导入文件 version = '1.0' 且含 `runtime_config`
- **THEN** 解析时校验结构 + 白名单 + kind
- **WHEN** 校验失败
- **THEN** 该题目标记为 failed，reason 包含失败原因
- **THEN** 不影响其他题目的导入

#### Scenario: 导入旧版本文件（runtime_config 缺失）

- **WHEN** 导入文件 version = '1.0' 且 `runtime_config` 字段缺失
- **THEN** 视为 null 处理（向后兼容）
- **THEN** 题目标记为 created/updated，ImportItemResult 不含 warning
- **THEN** 旧题目回退到单容器路径（与导入前一致）

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
- **THEN** 响应体包含 `runtime_config: RuntimeConfig | null`

#### Scenario: 列表 API 不暴露 runtime_config

- **WHEN** 用户查询题目列表
- **THEN** 列表项不包含 `runtime_config` 字段（避免列表响应过大）
- **THEN** 仅返回基础元数据（id / display_id / title / difficulty 等）

### Requirement: evaluator 网络配置

系统 SHALL 支持按题目配置 evaluator 容器联网开关 `runtime_config.evaluator.network`，缺省关闭（与现状一致）。

#### Scenario: network 字段缺省

- **WHEN** `runtime_config.evaluator.network` 缺省或为 `null`
- **THEN** 系统视为 `{"enabled": false}`（evaluator 无网，向后兼容）

#### Scenario: network.enabled 为布尔

- **WHEN** 用户设置 `runtime_config.evaluator.network`
- **THEN** 系统校验 `enabled` 必须为布尔值
- **WHEN** `enabled` 非布尔（字符串/数字等）
- **THEN** 返回 HTTP 400 + 明确错误信息（如 `runtime_config.evaluator.network 必须是对象` / `runtime_config.evaluator.network.enabled 必须是布尔值`）

#### Scenario: network.enabled=true 生效

- **WHEN** `runtime_config.evaluator.network.enabled = true` 且提交评测
- **THEN** judge 以 bridge 网络模式创建 evaluator 容器
- **THEN** solution 容器仍为 `network_mode: none`