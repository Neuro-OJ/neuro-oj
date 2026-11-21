## Context

当前 Provider 写入路由已有局部 gateway 错误映射，但读取和配额路由仍让异常进入全局错误处理；E2E 排名断言使用可选链比较，无法识别空数组；运行期错误用例仍兼容旧的 `finished + 0` 行为。

## Goals / Non-Goals

**Goals:**

- 集中复用管理端 gateway 错误映射，覆盖所有转发入口和网络不可用情况。
- 保持现有成功响应结构不变，并让评测与 E2E 断言匹配当前协议。
- 增加最小必要的路由测试，覆盖 404、400、上游不可用和未知异常。

**Non-Goals:**

- 不改变 gateway 内部 API、数据库结构或 judge 协议。
- 不重构与本次问题无关的 E2E helper 或认证并发机制。

## Decisions

- 在路由层统一捕获 gateway 错误：服务层继续使用 `LlmGatewayError` 表达 HTTP 非 2xx，路由把它转为 AppError；网络异常转为 `ServiceUnavailableError`。这样全局错误处理可以稳定输出既有错误响应格式。
- 所有 gateway 调用入口复用同一个映射函数，而不是仅修复当前暴露问题的两个写入路由，避免读取路径保留 500 缺口。
- E2E 断言显式检查数组长度，并将运行期错误断言收紧为 `error`，防止测试继续掩盖协议回归。

## Risks / Trade-offs

- [Risk] gateway 网络异常的 HTTP 状态从 500 变为 503，调用方若依赖 500 需要适配 → 这是更准确的依赖不可用语义，成功响应不受影响。
- [Risk] 收紧运行期错误测试可能暴露其他 judge 状态映射问题 → 失败结果可直接定位协议未满足要求。

## Migration Plan

无需数据迁移；部署 core 与测试代码后重新运行相关模块检查和 E2E。
