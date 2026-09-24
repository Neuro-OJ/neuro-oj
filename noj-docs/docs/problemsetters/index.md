# 出题人文档

出题人文档帮助你把一道题从想法变成上线评测。与传统 OJ 不同，你不是准备输入输出文件，而是编写一个 **evaluator**（`evaluate.py`），由它调用用户提交的函数并决定评分。

::: tip 从这里开始
第一次出题请看[快速出一题](quick-start.md)，它给出 5 步端到端路径；其余页面按需查阅。
:::

## 文档内容

| 页面 | 讲什么 |
|------|--------|
| [快速出一题](quick-start.md) | 新出题人：5 步端到端路径 |
| [Web 题目编辑器](web-editor.md) | 创建题目、配置运行时、上传支持包、发布前预检 |
| [A+B 示例题](ab-example.md) | 一份完整可参考的样例题 |
| [出 LLM 调用题](llm-problem.md) | 配置 Provider、开启联网并通过 `llm.complete` 调用真实 LLM API |
| 产物提交题 | 配置 zip 产物提交并选择 Solution / Solution AI 运行时，见[Web 题目编辑器 § 产物提交题](web-editor.md#产物提交题) |
| 客观题套卷 | 创建单选 / 多选 / 判断小题，无需评测容器，见[功能主题](../features/objective.md) |

## 相关系统性文档

- 评测机制与 SDK 见[评测机制与 SDK](../mechanisms/)。
- 题目规范及质量要求见[题目规范及质量要求](../standards/)。
