# Agent Note: 派发测试夹具使用确定题号

Status: implemented

## Problem

PR #694 的 Core submission job 121478004596 输出 488 passed / 1 failed。
失败发生在旧版本派发夹具插入题目时：随机生成的题号 97710 命中
problems_domain_number_unique，尚未进入待测业务逻辑。

## Decision

该测试文件的单写入者隔离夹具按当前域现有最大题号加一分配，替代三处小区间随机数。
真实唯一约束和全部派发断言继续生效。

## Alternatives considered

扩大随机区间或重跑不能消除碰撞；删除唯一约束违背产品合同。
不向生产代码加入测试专用分配逻辑，查询只保留在测试文件中。

## Consequences

测试数据分配由当前隔离库事实决定，避免同一文件累积题目后的随机失败。 该 helper
仅适用于当前串行夹具，不是生产并发题号分配器。
