# Postmortem

严重事故/重大回归必须写一页 postmortem，记录事实、根因与防复发措施。

## 模板

```markdown
# Postmortem: <标题>

- 日期：YYYY-MM-DD
- 影响：<影响范围>
- 严重级：P0 / P1 / P2

## 事实

<按时间顺序记录发生了什么，避免归因和情绪>

## 根因

<技术/流程根因>

## 防止复发

- [ ] <措施 1>
- [ ] <措施 2>
```

## 规则

- postmortem 只记录事实，不追责。
- 防复发措施必须有 owner 和验收条件。
- 严重事故 PR 必须附带 postmortem。
