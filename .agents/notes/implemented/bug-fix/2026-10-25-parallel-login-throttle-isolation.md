# Agent Note: 隔离并行登录限流测试的环境开关

Status: implemented

## Problem

登录限流测试为了临时打开限流而删除并恢复进程级 `NOJ_ENV`。并行验收 runner
中其它测试也会读写该变量，导致登录限流测试在第 10 次失败后检查锁定状态时
可能突然回到“限流关闭”语义，出现不可重复的失败。

## Decision

保留 `NOJ_ENV=test` 的测试进程环境，只在测试用例范围内设置并恢复
`RATE_LIMIT_ENABLED=true`。这是 `isRateLimitEnabled()` 已定义的测试覆盖开关，
不会改变生产路径，也不会把共享环境切换到 development/production。

## Alternatives considered

不把并行失败标记为可忽略，也不通过重试测试隐藏竞态；不修改生产锁定阈值或
把测试强制串行。直接删除 `NOJ_ENV` 会继续与其它测试争用进程级环境，因此不采用。

## Consequences

登录限流测试在单文件和双分片并行 runner 下均可稳定验证；并行 Core 复验得到
2246 passed / 0 failed / 2 ignored。其它需要临时打开限流的测试仍须遵守同一
环境隔离约定。
