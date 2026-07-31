## Purpose

定义全局搜索对社区知识内容（题解与讨论）的索引与检索范围，扩展搜索类型 `type=community`。

## Requirements

### Requirement: 搜索社区知识内容

全局搜索 SHALL 支持 `type=community`，搜索已发布题解和讨论的关联题目 ID 或标题、帖子标题与正文，并 MUST NOT 搜索短动态、待审、隐藏或删除内容。

#### Scenario: 搜索题解标题

- **WHEN** 用户搜索词命中已发布题解标题
- **THEN** 响应返回内容 ID、类型、标题、作者、关联题目和发布时间

#### Scenario: 搜索关联题目

- **WHEN** 用户搜索词命中已发布题解关联的题目 ID
- **THEN** 响应返回该题解帖子
