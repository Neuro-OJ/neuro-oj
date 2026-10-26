# Agent Note: 默认域策略与客观题参赛夹具契约

Status: implemented

## Problem

全 core 回归发现两个旧夹具未跟随工作空间归属：管理员策略用例没有 main 题目
绑定，客观题固定版本用例的参赛账号没有 main 成员关系。同时，题库策略公共门面
改为绑定策略后，revision 冲突丢失了已有的稳定错误码。

## Decision

管理员夹具显式建立默认域归属和本域绑定，断言策略写入绑定而非源题全局字段。
客观题参赛夹具显式授予基础成员身份。有效策略 revision 冲突统一返回
`EFFECTIVE_POLICY_REVISION_CONFLICT`，保持默认域兼容入口的错误契约。

## Alternatives considered

- 放宽不存在绑定和非成员参赛的生产检查：会绕过已确认域归属，不采用。
- 仅修改冲突断言为通用错误码：丢失稳定客户端契约，不采用。

## Consequences

标准 PostgreSQL admin 测试 16 项通过，objective 66 项通过；日志
`/tmp/noj-root-admin-policy-0134.log`、`/tmp/noj-root-objective-pu-0134.log`。
首次全量回归为 2204 项通过、2 项失败、17 项忽略，此记录修复这两个失败，
后续完整回归仍须在最终代码状态运行，不用局部通过替代全量签收。
