# NOJ 文档

NOJ（Neuro OJ）是面向大模型能力评测和编程实训场景的在线评测系统。它提供题目管理、代码提交、评测队列、Docker 沙箱执行和结果回传能力。

这份文档按读者组织：

- [做题人](users/index.md)：了解如何注册登录、查找题目、提交代码和理解评测结果。
- [运营者](operators/index.md)：了解如何启动、初始化、部署和维护一个 NOJ 实例。
- [出题人](problemsetters/index.md)：了解 NOJ 的评测模型、支持包结构、测试数据和 SDK 语义。
- [参考](reference/index.md)：查询术语、结果状态和稳定概念。

## 推荐阅读路径

如果你只是使用 NOJ 做题，从[做题人快速开始](users/getting-started.md)开始。

如果你要运行一套 NOJ 实例，先阅读[本地启动](operators/local-start.md)，再阅读[初始化与 seed](operators/seed.md)和[Judge Worker 运维](operators/judge-workers.md)。

如果你要编写题目，先阅读[评测模型](problemsetters/judge-model.md)。NOJ 不是传统的 stdin/stdout OJ，出题人需要编写 evaluator，通过 SDK 调用用户提交的函数并决定评分。
