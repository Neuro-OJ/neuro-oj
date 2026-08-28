# Agent Notes

本目录记录影响 NOJ 代码库的决策与提案，重点保存“为什么”和“放弃了什么”。

## 目录结构

每篇 Agent Note 的路径编码两个维度：

```text
{lifecycle}/{class}/yyyy-mm-dd-topic-title.md
```

- **lifecycle**：`implemented`（已实现）或 `proposed`（提案中）。
- **class**：决策分类，当前允许：
  - `feature`：新用户/模型可见能力
  - `bug-fix`：修复缺陷
  - `simplification`：删除代码/行为/表面积
  - `architecture`：已交付源码的结构性决策
  - `process`：工具、流程、规范
  - `testing`：测试基础设施与策略

## 文件格式（implemented）

```markdown
# Agent Note: <标题>

Status: implemented

## Problem

## Decision

## Alternatives considered

## Consequences
```

- `Status:` 必须与目录 lifecycle 一致。
- `## Alternatives considered` 必须存在。
- implemented 记录使用当前时态，描述“现状是什么”，不使用 proposal/plan 类章节。

## 何时写

非平凡变更必须新增或更新对应 Agent Note：

- 改变行为、架构、跨文件契约；
- 改变流程、工具、测试策略；
- 改变磁盘/网络/配置格式；
- 决策可能被日后重新讨论。

纯机械或局部编辑可豁免。

## 校验

CI 运行：

```bash
deno run -A scripts/verify-agent-note-format.ts
```

脚本会检查路径分类、状态行和必需章节。
