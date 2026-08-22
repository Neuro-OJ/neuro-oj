## Context

Solution 容器通过 SDK 注册函数，不向用户代码提供标准输入。P1001 模板和评测器均以一个字符串参数调用 `solve`，只有 E2E 样例仍使用旧标准输入写法。

## Goals / Non-Goals

**Goals:**

- 使 E2E 样例严格遵循题目模板。
- 在用户代码抛出异常时输出确定的评测结果。

**Non-Goals:**

- 不改变评测 SDK 或 Docker 沙箱协议。

## Decisions

- 所有 P1001 E2E 样例均定义 `solve(input_str)`，返回字符串结果。
- 除单次调用超时外，评测器记录调用异常并以零分 `RuntimeError` 结束；调用超时继续由评测机映射为 `TimeLimitExceeded`。

## Risks / Trade-offs

- [运行异常不再显示为错误答案] → 结果语义更准确，且与 E2E 断言一致。
