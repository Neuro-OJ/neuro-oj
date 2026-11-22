# Agent Note: 工作空间授权与数据库约束工程矩阵

Status: implemented

## Problem

Instance、Domain、教学、比赛及 LLM 的权限分布在不同模块。
只按产品角色描述会混淆域进入、具体资源资格和返回字段，也容易将服务写入不变量误写为已完成的数据库收缩。

## Decision

新增
[工程权限矩阵](../../../../dev-docs/engineering/workspace-authorization-matrix.md)，
以当前公开门面、能力映射、Schema 及 core 0136 为依据。
分别列出六种域角色、六项助教能力、比赛组织与参赛关系、结果字段、共享撤销和历史教学读取，
并记录 Provider 归属、原子 revision、平台敏感评测字段、错误契约及审计目标。

数据约束区分数据库唯一键／CHECK／复合 FK 与服务状态授权。 源题与题单域已 NOT
NULL；执行和社区域仍处于 nullable 扩展，复合 FK 的 MATCH SIMPLE
不能证明空键关联。
普通练习、账号事件、整体反馈等合理空值单独说明，不将它们列为无条件收缩目标。

## Alternatives considered

- 直接重述产品计划为实现状态：会掩盖数据库待收缩及旧接口的契约差异。
- 只列角色表：无法解释源码、比赛答案和教学历史的组合授权。
- 为文档新增授权框架或修改 Schema：本批只提供当前实现的可核对依据。

## Consequences

review 可沿每项表格中的源码链接核实，后续归属收缩迁移需要同步更新 nullable
清单。 当前文档不是自动生成目录或新的权限真相源，实际判断仍由公开服务门面执行。
本批只新增工程文档及本 Note，不修改生产代码、测试、Schema 或文档配置。
