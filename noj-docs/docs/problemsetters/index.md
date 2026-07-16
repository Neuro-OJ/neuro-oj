# 出题人文档

NOJ 的出题模型与传统 OJ 不同。你不是只准备输入输出文件，而是编写一个 evaluator，由 evaluator 调用用户提交的函数并决定评分。

## 核心概念

- 用户提交 `solution.py`。
- 出题人提供 `evaluate.py`、测试数据和其他支持文件。
- Evaluator 运行在独立容器中。
- Solution 运行在独立容器中。
- Evaluator 通过 SDK 调用用户函数。

正式出题的默认入口是 Web 管理界面：创建或编辑题目后，在题目编辑器中上传支持包 zip。仓库里的 seed 脚本只用于样例题和开发环境初始化，不是正式出题发布流程。

## 推荐阅读顺序

1. [评测模型](judge-model.md)
2. [题目支持包](support-package.md)
3. [测试数据](cases.md)
4. [Evaluator SDK](evaluator-sdk.md)
5. [Solution SDK](solution-sdk.md)
6. [RPC 与可传递数据](rpc.md)
7. [A+B 示例题](ab-example.md)
