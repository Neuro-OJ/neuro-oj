## ADDED Requirements

### Requirement: 搜索高亮安全渲染
搜索结果高亮 SHALL 使用转义后分段渲染或文本节点组合，禁止将用户内容直接 v-html；前端分页参数 MUST 与后端一致。

#### Scenario: 搜索结果含恶意内容
- **WHEN** 搜索结果标题/正文包含 HTML 或事件处理器
- **THEN** 高亮显示为纯文本，脚本不执行
