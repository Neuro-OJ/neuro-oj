## Why

NOJ 当前的架构、部署、出题与评测模型散落在 README、AGENTS 和代码实现中，缺少面向不同读者的正式文档入口。随着双容器评测模型、支持包、Evaluator SDK 与 Solution SDK 语义逐步稳定，需要建立独立文档站，降低做题人、运营者和出题人的理解成本。

## What Changes

- 新增 `noj-docs` 文档站，使用 MkDocs Material 作为静态文档框架。
- 新增面向做题人的文档入口，覆盖注册登录、查看题目、提交代码、理解评测状态与结果。
- 新增面向运营者的文档入口，覆盖本地启动、部署、初始化 seed、支持包构建、对象存储、Judge Worker 与镜像白名单配置。
- 新增面向出题人的文档入口，重点说明 NOJ 的评测方式：
  - Evaluator 容器与 Solution 容器职责分离。
  - 出题人编写 `evaluate.py`，通过 NOJ Evaluator SDK 调用用户解答。
  - 用户提交代码运行在 Solution Host 中，通过 NOJ Solution SDK 暴露可调用函数。
  - 测试数据、评分逻辑、可见/隐藏用例和支持包打包方式。
- 新增参考文档，覆盖术语、评测结果状态、安全边界和常见问题。
- 将文档站纳入仓库级开发入口，提供本地预览、构建和后续部署基础。

## Capabilities

### New Capabilities

- `documentation-site`: 定义 NOJ 文档站的结构、读者分区、出题人评测模型说明、本地构建预览和维护要求。

### Modified Capabilities

无。

## Impact

- 新增 `noj-docs/` 目录及 MkDocs Material 配置、Markdown 文档和依赖声明。
- 可能新增仓库级脚本或说明，用于启动文档预览和构建静态站点。
- 不改变 `noj-core`、`noj-ui`、`noj-judge` 的运行时行为、API、数据库结构或消息协议。
- 后续 CI 可选择增加文档构建检查，但本变更先以可本地构建为验收标准。
