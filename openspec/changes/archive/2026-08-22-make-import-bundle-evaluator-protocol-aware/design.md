## Context

双容器评测通过 Evaluator 与 Solution 的 NDJSON 调用协议传递用户函数结果。静态输出的测试脚本没有验证该协议，也可能在并发环境中过早退出。

## Goals / Non-Goals

**Goals:**

- 覆盖导入包的真实双容器评测路径。
- 让导入包闭环测试稳定地等待函数调用结果。

**Non-Goals:**

- 不改变导入 API 或评测机通用协议。

## Decisions

- Evaluator 调用 `solve("1 2")`，仅返回字符串 `"3"` 时判定 Accepted；异常或不匹配均给出确定结果。
