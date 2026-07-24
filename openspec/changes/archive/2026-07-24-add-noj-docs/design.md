## Context

NOJ 已经形成 `noj-core`、`noj-ui`、`noj-judge` 三模块架构，评测链路包含数据库 seed、支持包构建、Redis MQ、Judge Worker、双容器运行时、Evaluator SDK 与 Solution SDK。当前这些知识主要分布在 README、AGENTS、OpenSpec、代码和测试中，不适合作为最终用户、OJ 运营者和出题人的稳定入口。

文档站需要服务三类读者：

- 做题人：需要理解账号、题目、提交、结果与错误状态。
- 运营者：需要理解部署、初始化、数据、存储、镜像、Judge Worker 和维护操作。
- 出题人：需要理解 NOJ 与传统 OJ 的差异，尤其是 Evaluator 主导评分、Solution Host 暴露函数、双容器隔离和支持包打包。

## Goals / Non-Goals

**Goals:**

- 在仓库中新增 `noj-docs`，作为独立文档站模块。
- 使用 MkDocs Material，以 Markdown 为主要文档格式。
- 提供清晰的三类读者导航：做题人、运营者、出题人。
- 优先补齐出题人文档，解释 NOJ 的评测模型、支持包结构、SDK 语义、用例组织和打包流程。
- 提供本地预览和静态构建命令，便于维护者验证文档。
- 让首批文档可通过搜索、目录和交叉链接被发现。

**Non-Goals:**

- 不在本变更中实现新的评测运行时能力。
- 不改变现有数据库、API、Redis 消息格式或 Docker 镜像白名单语义。
- 不将文档站做成 Nuxt 应用，也不复用 `noj-ui` 的前端构建链。
- 不在首版中强制接入生产部署域名、评论系统、版本切换或多语言站点。
- 不把 AGENTS、OpenSpec 或内部开发说明完整迁移成公开文档。

## Decisions

### 使用 MkDocs Material

采用 MkDocs Material 作为 `noj-docs` 的文档框架。它适合以 Markdown 编写的技术文档，内置搜索、导航、代码块、提示框、标签页和较好的移动端展示，维护成本低于为文档单独维护 Nuxt/Vue 应用。

替代方案：

- VitePress：与前端技术栈更接近，但会引入 Node/Vite 生态维护面；对于当前以内容为主的文档站收益有限。
- Docusaurus：适合大型版本化产品文档，但对 NOJ 当前阶段偏重，目录和插件复杂度更高。
- 继续使用 README：入口简单，但无法满足多读者导航、搜索、教程和参考文档组织需求。

### 将 `noj-docs` 作为独立顶层模块

`noj-docs` 位于仓库顶层，与 `noj-core`、`noj-ui`、`noj-judge` 并列。它拥有自己的 `mkdocs.yml`、`docs/` 目录和依赖声明，避免把文档站构建逻辑混入三个运行时模块。

### 首批文档按读者而不是按代码模块组织

导航按 `users/`、`operators/`、`problemsetters/`、`reference/` 组织。代码模块视角适合开发者，但做题人和出题人更关心任务流，例如“如何提交”“如何出题”“如何部署 Worker”，而不是文件在哪个模块。

### 出题人文档优先解释评测模型

出题人入口首先说明 NOJ 的评测模型，再进入支持包、SDK、测试数据和打包命令。文档必须明确：

- `evaluate.py` 在 Evaluator 容器中运行。
- 用户代码在 Solution 容器中由 Solution Host 加载。
- Evaluator 通过 SDK 调用 Solution，Solution 不直接读取隐藏测试数据。
- 顶层输出、函数不存在、运行时异常等行为如何映射到评测结果。
- `visible.jsonl` 与 `hidden.jsonl` 的用途，以及支持包 zip 不包含用户代码。

### 文档命令保持简单

首版提供最小命令：

- 本地预览：`mkdocs serve`
- 静态构建：`mkdocs build --strict`

依赖管理可以使用 `requirements.txt` 或等价的 Python 依赖声明。若后续需要 CI，再将严格构建命令接入仓库 workflow。

## Risks / Trade-offs

- 文档与实现漂移 -> 在 tasks 中加入与现有代码、seed、打包脚本和 E2E 行为的交叉核对；文档示例以当前实现为准。
- Python 文档工具链增加新依赖 -> 将依赖限制在 `noj-docs` 内，不影响 core/ui/judge 的构建。
- 出题人文档过于抽象 -> 首版必须包含最小可运行题目结构、`evaluate.py` 示例、`solution.py` 示例和打包流程。
- 过早设计完整信息架构导致实现变慢 -> 首版只覆盖核心路径和参考页骨架，后续再扩展部署细节、FAQ 和高级出题模式。
