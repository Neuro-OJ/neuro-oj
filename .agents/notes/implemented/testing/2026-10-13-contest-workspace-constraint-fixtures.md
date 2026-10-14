# Agent Note: 比赛归属非空与提交复合外键夹具

Status: implemented

## Problem

比赛和赛题的使用域、赛题绑定已收紧非空，提交与比赛新增同域复合外键。
旧赛题夹具未填写绑定，部分统计与共享测试通过改写比赛域模拟另一个域。
这些形态不符合真实比赛归属，也会让原业务断言被约束错误提前阻断。

## Decision

新增 contestProblemExecutionForTest，先读取父比赛的真实域，复用该域已有绑定。
仅源题属于同域时允许建立 owned 绑定；跨域源题缺目标域引用时明确失败，不从
源域推导比赛执行归属。既有 insertContestProblems 复用该门面，移除空域退回 main
的旧夹具兼容。

共享赛期 fixture 只使用 shared Schema 构建 main owned 绑定，不依赖测试 helper
或业务模块。非 main 使用域由调用方显式提供，题目必须已有目标绑定；所有
赛题写入实际父比赛域与绑定。固定版本及比赛计分依据保留原值。

十个调用文件显式补赛题归属或 main 比赛域。共享可用性测试分别创建目标域与
源域比赛，不再移动一场已有赛题的比赛；补断言验证缺目标域引用时 helper
拒绝。私校统计夹具也直接创建学校域比赛，保留学校提交不计 main 榜及学校
比赛不扩大保密范围的原断言。

本批不编写旧比赛回填，不将未知历史比赛猜归 main；Schema、DDL、迁移及新增
数据库约束测试由协调 agent 独立处理。本批仅 fixture、helper 和本记录变更。

## Alternatives considered

- 用源题域填写赛题：引用公共题的学校比赛会错误归入公共域。
- 缺绑定就自动建立 shared 或回退 main：掩盖缺失的目标域共享配置。
- 修改赛题之后改父比赛域：违反固定归属与同域复合外键。
- shared fixture 调用业务模块初始化：共享层反向依赖业务层。

## Consequences

比赛题与关联提交的测试身份按实际使用域一致，引用源题仍保留来源身份。
验证采用标准 contest、submission、query、education 及必要 catalog 模块的
PostgreSQL 与 PGlite 回归，独立 schema 与隔离 Redis 不影响真实运行栈。
类型、格式和边界门禁检查随冻结快照执行。

最终标准回归：contest PostgreSQL 117/0、PGlite 116/0（1 项真实 PG 场景忽略）；
submission PostgreSQL 381/0（10 忽略）、PGlite 350/0（41 忽略）；query
PostgreSQL 37/0、PGlite 31/0（6 忽略）；education PostgreSQL 119/0（1
忽略）、PGlite 118/0 （2 忽略）；catalog 两库均 366/0。各轮迁移与种子
8/0。没有为修复新增忽略， 完整类型检查、受影响文件格式与 lint、域边界和 Agent
Note 检查通过。
