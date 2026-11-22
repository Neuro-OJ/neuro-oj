# Agent Note: 域比赛提交封装保持赛制允许列表

Status: implemented

## Problem

真实 OI Native 比赛端到端测试发现，OI 本人提交列表在结果投影删除 problem
对象后仍读取其标题，产生 500。IOI、严格和 ACM
详情已经裁剪结果，域封装再次按普通练习投影又添加 output 和 output_truncated
空字段，不符合赛制允许列表。

## Decision

域列表从当前已授权的资源元数据读取题名，资源撤销后仍显示不可用。详情保留比赛层已标记
result_visibility 的最终投影，不再重新添加字段；普通练习和比赛结束后的原始 OI
结果继续执行数据裁剪。

## Alternatives considered

- 用未裁剪的提交对象兜底：可能重新引入成绩或评测数据。
- 全部跳过 OI 投影：普通练习和赛后仍需要屏蔽原始评测输出。
- 允许结果中出现空的额外字段：会使公开 DTO 偏离已确认的字段白名单。

## Consequences

OI 列表可以正常显示中性受理信息。IOI、严格和 ACM 赛时结果不再出现 output 或
output_truncated。新增四赛制读取专项在 PostgreSQL 全部通过；真实 Native
全链路将在当前 core 构建后复跑确认。
