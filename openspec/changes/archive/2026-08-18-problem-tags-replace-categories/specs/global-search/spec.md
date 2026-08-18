## ADDED Requirements

### Requirement: 题目搜索匹配标签名

系统 SHALL 使题目搜索匹配标签名：当搜索词命中题目标签或算法标签的 `name` 时返回对应题目。匹配沿用现有 ILIKE 兜底策略（`escapeLikePattern` 转义），搜索结果响应结构不变。

#### Scenario: 搜索命中题目标签名

- **WHEN** 用户搜索词命中某题目标签 name
- **THEN** 搜索结果包含关联该标签的题目

#### Scenario: 搜索命中算法标签名

- **WHEN** 用户搜索词命中某算法标签 name
- **THEN** 搜索结果包含关联该算法标签的题目（发现路径，接受反向暴露）

#### Scenario: 搜索未命中标签名

- **WHEN** 搜索词不匹配任何标题、题号或标签名
- **THEN** 搜索结果为空
