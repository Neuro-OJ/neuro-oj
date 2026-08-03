# 快速出一题

本页是出题人的端到端路径：从设计题面到第一道题上线，约 5 步。

## 出题模型速览

与传统 OJ「准备输入输出文件」不同，Neuro OJ 需要你编写一个 **evaluator**（`evaluate.py`）：它在独立容器中运行，加载用户提交的函数并调用评分。核心概念见[评测模型](judge-model.md)。

## 步骤

1. **设计题目**：确定题面、函数签名与评分规则（如 `solve(a, b) -> int`，按返回值判分）。参考[A+B 示例题](ab-example.md)。

2. **创建题目**：在管理后台「题目」→「新建题目」，填写标题、描述（Markdown）、难度、题型与分类，并配置运行时限制（Evaluator / Solution 的时间与内存）。见[Web 题目编辑器](web-editor.md)。

3. **编写评测内容**：在本地编写 `evaluate.py` 与测试数据。测试数据格式**完全自由**（`visible.jsonl` / `hidden.jsonl` / SQLite / CSV 均可），只要 evaluator 能读取。见[测试数据](cases.md)。

4. **打包上传**：将题面、`evaluate.py` 与测试数据整理为统一题目包 zip，在编辑器中上传。包结构与 manifest 要求见[统一题目包](support-package.md)。

5. **自测发布**：
   - 用一版参考答案提交，确认状态与得分符合预期。
   - 检查隐藏用例的可见性（由 evaluator 控制）。
   - 修改后重新上传，或对旧提交触发 rejudge（管理端）。

## 进阶

- 自定义 evaluator 的调用细节与可传递数据类型：[Evaluator SDK](evaluator-sdk.md) / [RPC 与可传递数据](rpc.md)
- 镜像白名单与双容器运行时：[评测镜像与运行时](runtimes.md)
