## MODIFIED Requirements

### Requirement: 搜索分页响应

全局搜索响应 SHALL 返回当前页结果、`page`、`limit`、`has_more` 与 `took_ms`。服务 MUST 通过获取不超过 `limit + 1` 条记录计算 `has_more`，并且默认 MUST NOT 为分页执行精确 `COUNT(*)`。调用方传入 `include_total=true` 或 `include_total=1` 时，响应 MUST 额外返回精确 `total`。

#### Scenario: 默认搜索首屏

- **WHEN** 调用方不传入 `include_total` 且结果数超过当前页 `limit`
- **THEN** 响应返回至多 `limit` 条 `items` 与 `has_more=true`，且不返回 `total`

#### Scenario: 请求精确总数

- **WHEN** 调用方传入 `include_total=true`
- **THEN** 响应返回分页结果、`has_more` 与匹配结果的精确 `total`

#### Scenario: 最后一页

- **WHEN** 当前页之后不存在更多匹配结果
- **THEN** 响应返回 `has_more=false`
