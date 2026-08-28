# Agent Note: 防御模式回归测试

Status: implemented

## Problem

防御模式（路径穿越、炸弹限制、清理、回调隔离等）缺少专门的回归测试，安全规则被修改时可能静默失效。

## Decision

新增 `noj-core/tests/defensive-patterns_test.ts`，覆盖存储 key 的路径穿越与非法段校验：

- 拒绝 `../`、绝对路径、反斜杠、NUL、`.`/空段。
- 允许合法 key。

`noj-judge` 的 ZIP 路径穿越、条目数、单文件/总大小限制已有 `sandbox/container.rs` 内单元测试覆盖，本次不重复添加。

## Alternatives considered

- 为 judge 再写一份重复的 ZIP 测试：已有同层测试，维护成本高。
- 不添加测试：安全规则缺少回归保护。

## Consequences

- noj-core 存储 key 的安全边界有回归测试。
- 后续可继续为 event-bus 回调隔离、容器清理 quiescence 等补充测试。
