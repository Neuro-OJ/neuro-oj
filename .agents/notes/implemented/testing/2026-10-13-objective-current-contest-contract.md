# Agent Note: 客观题 E2E 对齐默认域与赛时原分

Status: implemented

## Problem

旧客观题 E2E 以 P/U 分类代替域角色，并期望 Kaggle 比赛隐藏本人总分，与批准的
新契约不一致。

## Decision

普通出题账号显式获得 main 的编辑者角色。题目创建取消旧分类；比赛正式交卷
检查本人原百分制总分，同时继续验证逐题答案、解析与正确性隐藏，一次正式
交卷规则和赛后复盘保持独立。

## Alternatives considered

- 提升出题账号为平台管理员：绕过真实域角色，不采用。
- 保留旧隐藏总分断言：与 Kaggle 本人原分规则冲突，更新具体期望。

## Consequences

最新隔离 local 栈通过标准 objective 入口，4 项实际通过、0 失败。日志为
`/tmp/noj-root-objective-current-final-20261013.log`。本批不声称全部客观题浏览器
或所有赛制完成；五赛制 Native HTTP 有独立验收记录。
