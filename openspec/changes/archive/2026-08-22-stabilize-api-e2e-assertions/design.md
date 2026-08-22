## Context

接口成功响应统一包装在 `data`。不同 Docker 环境对 OOM 的退出信息不一致，评测机可能报告 `MemoryLimitExceeded`、`RuntimeError` 或 `SystemError`。

## Goals / Non-Goals

**Goals:**

- 保持断言与 API 响应契约一致。
- 只在资源限制场景允许读取 error 终态。

**Non-Goals:**

- 不放宽其他评测测试的错误处理。

## Decisions

- 为 `pollSubmission` 增加可选的 error 终态返回开关，默认仍抛错。
- 内存压力测试显式开启该开关并列出平台可接受结果。
