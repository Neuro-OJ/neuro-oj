## ADDED Requirements

### Requirement: 存储 key 根目录约束
所有 storage provider 在读/写/删前 SHALL 解析并规范化 key，拒绝空 key、`..`、以 `/` 开头或解析后逃逸存储根目录的 key。

#### Scenario: key 包含 ..
- **WHEN** 存储操作收到含 `..` 的 key
- **THEN** 操作被拒绝，不访问根目录外路径
