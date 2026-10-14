# Agent Note: 校验待人工决策的 Agent Notes

Status: implemented

## Problem

Agent Notes 的目录约定允许 proposed，但校验器只接受 implemented。
无人值守工作需要记录待讨论的提案，不能将其伪装成已经交付的行为。

## Decision

路径校验接受 implemented 和 proposed；内容状态必须匹配生命周期。
两种记录保留相同的四个基础章节，implemented 继续禁止计划类章节。
目录扫描显式传入生命周期，默认的单文件校验仍按 implemented 处理。
新增测试覆盖提案有效及两种状态不能混用。

## Alternatives considered

- 跳过提案目录：容易留下未校验的长期记录。
- 一律使用 implemented：不能准确表达尚未拍板的产品事项。
- 引入新文档管理框架：现有目录约定与小幅校验扩展已经足够。

## Consequences

待讨论事项可以进入仓库并通过原有门禁，已实现记录的校验要求不变。
