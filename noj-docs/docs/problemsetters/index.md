# 出题人文档中心

在 Neuro OJ 中，出题人不再只是准备冰冷的 `input.txt` 与 `output.txt`，而是编写具有完全主动权的 **Evaluator（评测脚本）**。Evaluator 通过 RPC 直接调用选手提交的模块并按规则给出评分与诊断信息，这一范式天然契合大模型任务与复杂交互题型。

::: tip 第一次出题？从这里开始
推荐首先跟随 [快速出一题（5 步端到端路径）](quick-start.md)，从一个极简的平方计算器开始，跑通从编写评测脚本到在 Web 编辑器上线自测的完整流程。
:::

---

## 🛠️ 出题知识图谱

### 1. 快速上手与出题工具
- [快速出一题（5 步极速路径）](quick-start.md)：新出题人必备，5 步完成一道题目的编写、打包与发布。
- [Web 题目编辑器使用指南](web-editor.md)：题面 Markdown 编辑、时空限制配置、支持包上传与发布前一键预检。
- [A+B 样例题完整拆解](ab-example.md)：最简单的函数题模版，包含标准 `evaluate.py` 与标程参考。

### 2. 丰富题型实战指南
- [编写 LLM 智能体调用题](llm-problem.md)：配置大模型 Provider、开启受控联网，通过 `llm.complete` 或自建 Capability 评测选手的 Prompt 工程与 Agent 编排能力。
- [产物提交题制作（类 Kaggle）](web-editor.md#产物提交题)：配置选手上传 ZIP 压缩包（如模型权重、生成的预测 CSV），在 Solution 容器中自动化跑分。
- [客观题套卷出题与导入](./objective-problem.md)：单选题、多选题与判断题题库规范、questions.json 自动化导入与防作弊机制。

### 3. 题目规范与质量要求
- [题目规范与质量总览](../standards/index.md)：理解强制规范（MUST）与推荐质量（SHOULD）的界限。
- [统一题目包格式规范 (Problem Bundle)](../standards/problem-bundle.md)：题目包 ZIP 目录层次、`manifest.json` 元数据定义与校验规则。
- [测试数据与样例规范](../standards/test-data.md)：测试数据推荐格式、可见/隐藏用例组织与样例自测规范。
- [题目质量要求与自查清单](../standards/quality.md)：题目命名、难度标定、边界用例设计与发布前自查清单。

### 4. 评测脚本 SDK 与通信机制
- [Evaluator SDK 接口指南](../mechanisms/evaluator-sdk.md)：`SolutionRunner`、函数调用限时 `call(..., timeout_ms)`、评分结果输出 `result(...)` 详细 API。
- [Solution SDK 接口指南](../mechanisms/solution-sdk.md)：选手端暴露函数、注册入口与调用 Capability 的标准姿势。
- [如何提供受限网络能力](../mechanisms/capability-networking.md)：为评测端注册 Capability，安全可控地为选手代码赋予网络访问通道。
- [评测模型与超时状态映射](../mechanisms/judge-model.md)：深入理解 Evaluator 整体超时与单次函数调用的三种结局及状态映射。
