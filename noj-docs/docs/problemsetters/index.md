# 出题人文档

Neuro OJ 的出题模型与传统 OJ 不同。你不是只准备输入输出文件，而是编写一个 evaluator，由 evaluator 调用用户提交的函数并决定评分。

## 核心概念

- 用户提交 `solution.py`。
- 出题人提供 `evaluate.py`、测试数据和其他支持文件。
- Evaluator 运行在独立容器中。
- Solution 运行在独立容器中。
- Evaluator 通过 SDK 调用用户函数。

正式出题的默认入口是 Web 管理界面：创建或编辑题目后，在题目编辑器中上传统一题目包 zip。仓库里的 `problems:import` / `dev-setup` 只用于样例题和开发环境初始化，不是正式出题发布流程。

## 推荐阅读顺序

1. [评测模型](judge-model.md)
2. [Web 题目编辑器](web-editor.md)
3. [统一题目包](support-package.md)
4. [测试数据](cases.md)
5. [Evaluator SDK](evaluator-sdk.md)
6. [Solution SDK](solution-sdk.md)
7. [RPC 与可传递数据](rpc.md)
8. [评测镜像与多语言](runtimes.md)
9. [A+B 示例题](ab-example.md)
