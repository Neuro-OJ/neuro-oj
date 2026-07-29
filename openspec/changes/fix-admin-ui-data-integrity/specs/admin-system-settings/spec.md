## ADDED Requirements

### Requirement: 并发保存保留独立设置草稿
保存或重置单个设置后，系统 SHALL 仅同步该设置的有效值和草稿。其他未保存设置的草稿不得因该操作被重置。

#### Scenario: 连续保存不同设置
- **WHEN** 管理员修改设置 A 和 B，并在 B 仍有未保存草稿时保存 A
- **THEN** 设置 B 的草稿保持不变
