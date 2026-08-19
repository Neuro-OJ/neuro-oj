## ADDED Requirements

### Requirement: 创建自测

系统 SHALL 提供 `POST /api/v1/problems/:id/self-test` 端点，允许登录用户对编程题发起自测。

请求体 MUST 包含 `language` 与 `code`，可选 `file_name`。校验规则 MUST 与正式提交一致：题目存在、语言受支持、`runtime_config` 存在、代码为字符串且长度不超过 100KB、评测镜像通过白名单校验。

创建成功时系统 MUST 返回 `201` 和自测响应，包含 `id`（格式为 `st_<uuid>`）、`status`、`problem_id`、`language`、`code`、`file_name`、`created_at`；初始 `status` 为 `pending`，入队成功后为 `judging`。

系统 MUST 在创建自测时执行自测专用限流（IP + 用户双维度），默认每用户 60 秒窗口最多 4 次，IP 维度保留较宽的防滥用上限。

系统 MUST 仅允许普通题库场景发起自测；竞赛模式下不提供该端点或返回 403/404。

#### Scenario: 登录用户创建自测

- **WHEN** 登录用户 POST `/api/v1/problems/:id/self-test`，提供合法 `language` 和 `code`
- **THEN** 系统创建 `self_tests` 记录并推入评测队列，返回 `201` 和自测 ID

#### Scenario: 未登录创建自测被拒

- **WHEN** 未登录用户 POST `/api/v1/problems/:id/self-test`
- **THEN** 系统返回 `401`

#### Scenario: 题目不存在

- **WHEN** 用户 POST 不存在的题目 ID 的 self-test
- **THEN** 系统返回 `404`

#### Scenario: 语言不支持

- **WHEN** 用户 POST 的 `language` 不在支持语言列表中
- **THEN** 系统返回 `400`

#### Scenario: 代码超长被拒

- **WHEN** 用户 POST 的 `code` 长度超过 100KB
- **THEN** 系统返回 `400`

#### Scenario: 自测限流触发

- **WHEN** 用户在限流窗口内发起超过阈值的自测请求
- **THEN** 系统返回 `429`

### Requirement: 查询自测结果

系统 SHALL 提供 `GET /api/v1/self-tests/:id` 端点，允许自测 owner 或管理员查询自测状态与结果。

响应 MUST 包含 `id`、`user_id`、`problem_id`、`language`、`code`、`file_name`、`status`、`result_status`、`score`、`output`、`details`、`time_ms`、`memory_kb`、`judge_started_at`、`judge_finished_at`、`created_at`。

非 owner 且非 admin 访问 MUST 返回 `404`（不暴露自测存在）。

#### Scenario: owner 查询自测结果

- **WHEN** 自测 owner GET `/api/v1/self-tests/:id`
- **THEN** 系统返回该自测的状态、分数、输出与详情

#### Scenario: 非 owner 查询被拒

- **WHEN** 非 owner 且非 admin 用户 GET `/api/v1/self-tests/:id`
- **THEN** 系统返回 `404`

#### Scenario: 自测不存在

- **WHEN** 用户 GET 不存在的 `/api/v1/self-tests/:id`
- **THEN** 系统返回 `404`

### Requirement: 自测结果不计入正式记录

自测结果 MUST NOT 写入 `submissions` 或 `evaluationResults` 表。

自测完成 MUST NOT 影响：提交历史、今日/总提交统计、榜单、AC 活动/算法标签门控、竞赛排名。

系统 SHOULD 将自测结果长期保留在 `self_tests` 表中。

#### Scenario: 自测后提交历史不变

- **WHEN** 用户完成一次自测后查询自己的提交历史
- **THEN** 提交历史中不出现该自测记录

#### Scenario: 自测后统计不变

- **WHEN** 用户完成一次自测后查询今日/总提交统计
- **THEN** 统计值与自测前一致

#### Scenario: 自测后榜单不变

- **WHEN** 用户完成一次自测后查询榜单
- **THEN** 榜单不因该自测发生变化

### Requirement: 自测结果路由与幂等写回

评测结果消费者 MUST 根据 `submission_id` 前缀 `st_` 将结果路由到自测结果写回逻辑。

自测结果写回 MUST 更新 `self_tests` 表的状态为 `finished` 或 `error`，并写入分数、输出、详情、耗时、内存、完成时间。

自测结果写回 MUST 是幂等的：已处于终态的自测结果 MUST 被忽略。

自测结果写回 MUST NOT 触发正式提交的统计缓存更新、榜单刷新或 AC 活动创建。

#### Scenario: 自测结果正常写回

- **WHEN** noj-judge 返回 `submission_id` 以 `st_` 开头的评测结果
- **THEN** 系统将该结果写入 `self_tests` 表，不写入正式表

#### Scenario: 重复自测结果被忽略

- **WHEN** 消费者收到同一自测 ID 的重复终态结果
- **THEN** 系统忽略重复结果，不覆盖已存在结果

#### Scenario: 自测结果不触发 AC 活动

- **WHEN** 自测结果为 Accepted
- **THEN** 系统不创建 `first_accepted` 社区活动

### Requirement: 自测前端交互

编辑器页面 SHALL 在普通题库模式提供“自测”按钮。

点击自测后，前端 SHALL 调用 `POST /api/v1/problems/:id/self-test`，并在收到自测 ID 后轮询 `GET /api/v1/self-tests/:id`，直到状态为 `finished` 或 `error`。

编辑器侧栏 SHALL 提供“自测”Tab，展示自测状态、分数与输出（输出按 API 截断长度展示）。

竞赛模式 MUST 不显示“自测”按钮。

#### Scenario: 编辑器发起自测

- **WHEN** 用户在普通题库编辑器点击“自测”
- **THEN** 前端创建自测并轮询结果，侧栏展示状态/分数/输出

#### Scenario: 竞赛模式不显示自测按钮

- **WHEN** 用户进入竞赛模式编辑器
- **THEN** 工具栏不显示“自测”按钮

### Requirement: 自测队列可见性

自测任务 MUST 与正式任务共用评测队列。

队列概览 MUST 在 `pending`、`judging`、`recently_completed` 中包含自测条目，并标记 `kind: "self_test"`，使前端可以区分自测与正式提交。

#### Scenario: 队列页展示自测条目

- **WHEN** 队列中存在自测任务
- **THEN** 队列概览返回该自测条目且 `kind` 为 `self_test`

#### Scenario: 队列页展示正式提交条目

- **WHEN** 队列中存在正式提交任务
- **THEN** 队列概览返回该正式提交条目且 `kind` 为 `submission`（或兼容缺省）
