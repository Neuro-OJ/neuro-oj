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

### Requirement: 搜索高亮安全渲染
搜索结果高亮 SHALL 使用转义后分段渲染或文本节点组合，禁止将用户内容直接 v-html；前端分页参数 MUST 与后端一致。

#### Scenario: 搜索结果含恶意内容
- **WHEN** 搜索结果标题/正文包含 HTML 或事件处理器
- **THEN** 高亮显示为纯文本，脚本不执行

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
