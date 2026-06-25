## ADDED Requirements

### Requirement: 用户查看提交历史列表

系统 SHALL 提供 `/submissions` 页面，显示当前已登录用户的提交历史列表，支持分页和多条件筛选。

页面 SHALL 对所有已登录用户开放（user 级别权限），无需管理员权限。
页面 MUST 受认证守卫保护（未登录用户跳转到 `/login`）。
页面 MUST 使用 `GET /api/v1/submissions`（用户端 API），该 API 在服务端自动按当前用户隔离——用户默认只能看到自己的提交，不额外提供 `user_id` 筛选。

列表默按 `created_at` 降序排列（最新提交在前）。

#### Scenario: 登录用户访问提交历史页

- **WHEN** 已登录用户访问 `/submissions`
- **THEN** 页面显示该用户的所有提交记录列表，按时间降序排列

#### Scenario: 未登录用户访问提交历史页

- **WHEN** 未登录用户访问 `/submissions`
- **THEN** 页面跳转到 `/login`

### Requirement: 列表展示字段

提交历史列表的每一行 SHALL 展示以下字段：

| 字段 | 说明 | 格式 |
|------|------|------|
| 提交 ID | 唯一标识 | 显示前 8 位 + "..." |
| 题目 | 题目名称 | 显示 `problem.title`，带链接到 `/problems/:id` |
| 语言 | 编程语言 | 显示语言标签（如 "Python 3"） |
| 状态 | 评测结果 | 显示带颜色标签的结果状态 |
| 得分 | 评测分数 | `result.score / 100` 格式（如 "80.0 分"），无结果时显示 "--" |
| 耗时 | 运行时间 | `result.time_ms` 格式化，无结果时显示 "--" |
| 内存 | 内存使用 | `result.memory_kb` 格式化，无结果时显示 "--" |
| 提交时间 | 创建时间 | 本地化日期时间格式 |

#### Scenario: 已完成提交展示完整信息

- **WHEN** 用户查看提交历史，某提交已完成评测（`status=finished`）
- **THEN** 该行展示题目名称、语言标签、评测结果状态标签、得分、耗时、内存和提交时间

#### Scenario: 评测中的提交不展示耗时/内存/得分

- **WHEN** 用户查看提交历史，某提交仍在评测中（`status=pending` 或 `judging`）
- **THEN** 该行展示提交状态标签（"等待评测"/"评测中"），得分、耗时、内存显示 "--"

### Requirement: 状态标签颜色

列表中的状态标签 SHALL 使用不同颜色区分评测结果：

| 状态 | 标签文字 | 颜色 |
|------|----------|------|
| Accepted | 答案正确 | 绿色 (#10b981) |
| WrongAnswer | 答案错误 | 红色 (#ef4444) |
| TimeLimitExceeded | 超出时间限制 | 橙色 (#f59e0b) |
| MemoryLimitExceeded | 超出内存限制 | 橙色 (#f59e0b) |
| RuntimeError | 运行时错误 | 红色 (#ef4444) |
| SystemError | 系统错误 | 红色 (#ef4444) |
| pending | 等待评测 | 灰色 |
| judging | 评测中 | 蓝色 |

当 `result` 存在时，优先显示 `result.status` 对应的评测结果标签；当 `result` 为 `null` 时，显示提交状态标签。

#### Scenario: 已完成提交显示绿色标签

- **WHEN** 提交的 `result.status` 为 `"Accepted"`
- **THEN** 状态标签显示绿色 "答案正确"

#### Scenario: 答案错误显示红色标签

- **WHEN** 提交的 `result.status` 为 `"WrongAnswer"`
- **THEN** 状态标签显示红色 "答案错误"

#### Scenario: 超时显示橙色标签

- **WHEN** 提交的 `result.status` 为 `"TimeLimitExceeded"`
- **THEN** 状态标签显示橙色 "超出时间限制"

#### Scenario: pending 状态显示灰色标签

- **WHEN** 提交的 `result` 为 `null` 且 `status` 为 `"pending"`
- **THEN** 状态标签显示灰色 "等待评测"

### Requirement: 筛选功能

提交历史列表 SHALL 支持以下筛选条件：

- 按题目：通过 `problem_search` 查询参数，在一个输入框中同时支持题目 ID 精确匹配和题目名称模糊搜索
- 按语言：通过 `language` 查询参数筛选（如 python3, cpp）
- 按状态：通过 `status` 查询参数筛选（pending / judging / finished / error）
- 按提交 ID：通过 `submission_id` 查询参数，支持提交 ID 前缀匹配（输入前几位即可）

管理后台 SHALL 额外支持按用户筛选：
- 按用户：通过 `user_search` 查询参数，在一个输入框中同时支持用户名模糊搜索和用户 ID 前缀匹配

筛选 SHALL 支持组合条件。应用筛选条件后重置页码为 1。筛选栏应包含清空筛选按钮。

#### Scenario: 按题目 ID 筛选

- **WHEN** 用户在题目输入框中输入 "1001" 并点击筛选
- **THEN** 列表仅显示 problem_id 为 "1001" 的提交记录

#### Scenario: 按题目名称模糊搜索

- **WHEN** 用户在题目输入框中输入 "T0-LMCC" 并点击筛选
- **THEN** 列表仅显示题目名称包含 "T0-LMCC" 的提交记录

#### Scenario: 按提交 ID 前缀搜索

- **WHEN** 用户在提交 ID 输入框中输入 "abc123"
- **THEN** 列表仅显示提交 ID 以 "abc123" 开头的记录

#### Scenario: 按用户名搜索（管理后台）

- **WHEN** 管理员在用户搜索框中输入 "john"
- **THEN** 列表仅显示用户名包含 "john" 的用户的提交记录

#### Scenario: 清空筛选

- **WHEN** 用户已应用筛选条件，点击清空按钮
- **THEN** 所有筛选条件重置，列表恢复为无条件显示

### Requirement: 分页

提交历史列表 SHALL 支持分页展示，每页 20 条记录。

当列表数据为空时 SHALL 显示空态提示"暂无提交记录"。
当列表加载中时 SHALL 显示加载态。
当接口请求失败时 SHALL 显示错误信息，并提供重试能力。

#### Scenario: 多页数据正常分页

- **WHEN** 用户有超过 20 条提交记录
- **THEN** 页面底部显示分页导航，可翻页查看

#### Scenario: 无提交记录

- **WHEN** 当前筛选条件无匹配提交，或用户从未提交过
- **THEN** 显示"暂无提交记录"空态提示

#### Scenario: 加载失败显示错误

- **WHEN** API 请求失败（网络错误、超时等）
- **THEN** 显示"加载提交记录失败"错误信息

### Requirement: 点击进入提交详情

列表中的每一行 SHALL 可点击，点击后跳转到对应的提交详情页 `/submissions/:id`。

操作列 SHALL 包含"查看"按钮，链接到详情页。

#### Scenario: 点击查看提交详情

- **WHEN** 用户在列表页点击某行的"查看"按钮
- **THEN** 页面跳转到 `/submissions/<id>`，显示该提交的完整详情
