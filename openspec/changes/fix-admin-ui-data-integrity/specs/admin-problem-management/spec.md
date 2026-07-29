## ADDED Requirements

### Requirement: 批量重测反馈实际入队结果
题目批量重测完成后，管理后台 SHALL 展示 total、queued 和 skipped 的实际数量；skipped 大于零时 SHALL 明确提示存在未入队任务。

#### Scenario: 部分任务未入队
- **WHEN** 批量重测响应的 total 为 10、queued 为 8、skipped 为 2
- **THEN** 页面提示已入队 8 条、未入队 2 条，而非仅显示总数
