# Agent Note: WASM 自测取消时的执行结果竞态

Status: implemented

## Problem

最终手动 CI 的 Judge Check 在自测取消回归中失败。取消分支主动结束异步执行，
返回空调用结果，却没有设置中断状态；后续 `expect` 因而 panic。原测试有时由 epoch
中断先返回错误，有时取消分支先返回，构成实际执行竞态。

## Decision

超时与取消分支都明确标记执行已中断。结果归入既有 SystemError 路径，外层
自测继续将取消映射为 Ignored。完成执行的返回值和算法 TLE 判定保持原规则。
使用现有真实取消测试、完整 nextest 及最终远端 CI 验证两条中断路径。

## Alternatives considered

- 重跑 CI 直到竞态没有出现：留下真实 panic，不采用。
- 对空值提供成功或算法零分默认值：掩盖取消原因，不采用。
- 增加重试或通用防御框架：分支已经知道自己取消了执行，无需额外机制。

## Consequences

取消自测不再尝试读取不存在的调用结果，不改变评测协议、业务成绩或沙箱权限。 完整
`cargo nextest run --all-targets --locked` 631 项通过、46 项专属跳过，
`cargo fmt --check` 与全目标 clippy 零警告。验证证据汇总在最终验收报告，
尚未完成的远端检查不提前记为通过。
