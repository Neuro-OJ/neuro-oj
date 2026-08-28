## MODIFIED Requirements

### Requirement: 点击进入提交详情

列表中的每一行 SHALL 可点击，点击后跳转到对应的提交详情页 `/submissions/:id`。

操作列 SHALL 包含"查看"按钮，链接到详情页。

当提交结果包含标准化的 `result.details.cases` 数组时，详情页 SHALL 展示测试点明细，至少包含用例标识、评测状态和单点耗时；可见用例还 SHALL 展示期望输出与实际输出。隐藏用例 SHALL 仅展示状态和资源耗时，不得展示输入、期望输出或实际输出。

详情页 SHALL 兼容历史结果中按 `details.visible.cases` 与 `details.hidden.cases` 分组、或使用 `id`/`expected`/`actual` 旧字段命名的测试点数据；无法识别的详情 SHALL 安全忽略，不影响总评测结果展示。

#### Scenario: 查看标准测试点结果

- **WHEN** 用户查看自己的提交详情，API 返回 `result.details.cases`，其中包含通过和失败的测试点
- **THEN** 页面按评测顺序展示每个测试点的标识、状态和耗时，并为可见测试点展示期望输出与实际输出

#### Scenario: 隐藏测试点只展示非敏感信息

- **WHEN** 提交详情包含 `visibility=hidden` 的测试点
- **THEN** 页面展示该测试点的状态和耗时，但不展示输入、期望输出或实际输出

#### Scenario: 兼容历史测试点结果

- **WHEN** 历史提交详情使用 `visible.cases`/`hidden.cases` 或 `id`/`expected`/`actual` 字段
- **THEN** 页面将其转换为统一明细后展示，隐藏分组仍按隐藏用例规则脱敏

#### Scenario: 没有可识别测试点详情

- **WHEN** 提交结果不存在 `details.cases` 且不存在可兼容的历史测试点结构
- **THEN** 页面不显示空的测试点面板，仍正常展示总状态、分数和评测输出

#### Scenario: 非授权访问提交详情

- **WHEN** 匿名用户或非提交者查看提交详情
- **THEN** API 返回的 `result.details` 为 null，页面不展示测试点明细

#### Scenario: 点击查看提交详情

- **WHEN** 用户在列表页点击某行的"查看"按钮
- **THEN** 页面跳转到 `/submissions/<id>`，显示该提交的完整详情
