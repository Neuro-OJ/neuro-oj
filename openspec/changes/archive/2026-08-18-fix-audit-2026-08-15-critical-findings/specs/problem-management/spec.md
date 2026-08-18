## ADDED Requirements

### Requirement: 支持包 URL 服务端受控
创建/更新题目的 `support_package_storage_url` SHALL 只接受服务端生成且匹配题目归属的 `noj-storage://` URL；客户端直接指定的任意 URL MUST 被拒绝或忽略。

#### Scenario: 更新题目写入他人对象 key
- **WHEN** 普通用户提交不属于自己题目的 S3 key
- **THEN** 服务端拒绝更新
