# 评测机制与 SDK

> 一句话：本部分面向出题人与集成开发者，讲清 Neuro OJ 的评测如何运转——双容器模型、两个 Python SDK、RPC 线格式、运行时镜像与受限网络能力。

| 页面 | 讲什么 |
| --- | --- |
| [评测模型](judge-model.md) | 双容器分工、调用链路与超时/状态映射 |
| [Evaluator SDK](evaluator-sdk.md) | 出题人如何调用用户函数、注册 capability、输出结果 |
| [Solution SDK](solution-sdk.md) | 用户如何暴露函数、调用 capability |
| [RPC 与可传递数据](rpc.md) | NDJSON 帧字段、错误码、类型白名单 |
| [评测镜像与运行时](runtimes.md) | 镜像白名单、语言标识与双容器运行方式 |
| [如何提供受限网络能力](capability-networking.md) | 用 capability 安全地把网络交给 solution |

::: tip 想先动手？
若你只想尽快跑通一道题，直接看[快速开始](../problemsetters/quick-start.md)与 [A+B 示例题](../problemsetters/ab-example.md)；本组页面用于理解底层机制与排错。
:::
