# 快速出一题

> 本页是出题人的端到端路径：从设计题面到第一道题上线，共 5 步。

## 出题模型速览

与传统 OJ「准备输入输出文件」不同，Neuro OJ 需要你编写一个 **evaluator**（`evaluate.py`）：它在独立的 Evaluator 容器中运行，加载用户提交的函数并调用评分；用户代码运行在另一个无网的 Solution 容器中。核心概念见[评测模型](judge-model.md)。

```text
你编写：evaluate.py（评分逻辑）+ 测试数据 + 题面
用户提交：实现题面声明的函数（如 solve(input_str) -> str）
评测：Evaluator 调用 Solution 中的函数，按返回值判分
```

## 步骤

1. **设计题目**：确定题面、函数签名与评分规则（例如 `solve(input_str) -> str`，按返回值判分）。可参考[A+B 示例题](ab-example.md)。

2. **创建题目**：在管理后台「题目」→「新建题目」，填写标题、描述（Markdown）、难度、题型与标签，并配置运行时限制（Evaluator / Solution 的时间与内存）。见[Web 题目编辑器](web-editor.md)。

::: warning 普通用户只能创建 U 型题
U 型（用户题）任意登录用户可创建；**P 型（主题题）仅管理员可创建**，且 P 型题默认公开。
:::

3. **编写评测内容**：在本地编写 `evaluate.py` 与测试数据。测试数据格式**完全自由**（`visible.jsonl` / `hidden.jsonl` / SQLite / CSV 均可），只要 evaluator 能读取。见[测试数据与样例规范](../standards/test-data.md)。

4. **打包上传**：将题面、`evaluate.py` 与测试数据整理为统一题目包 zip，在编辑器中上传。包结构与 manifest 要求见[题目包格式规范](../standards/problem-bundle.md)。

5. **自测发布**：
   1. 用一版参考答案提交，确认状态与得分符合预期。
   2. 检查隐藏用例的可见性（由 evaluator 控制）。
   3. 修改后重新上传，或对旧提交触发 rejudge（管理端）。

::: tip 提供初始代码模板
题目源码目录可提供初始代码模板（`problem.json` 的 `template` 字段，缺省 `template.py`）。编辑器在无本地草稿或点击「重置模板」时，通过 `GET /api/v1/problems/:id/template` 拉取该文件并填入代码框（返回 `{"data":{"content","language"}}`，文件不存在则 404）。

注意：这是**代码编辑器的初始代码（starter code）**，**不是**支持包模板下载；支持包需自行按[题目包格式规范](../standards/problem-bundle.md)组织后上传。
:::

::: warning 题号 `number` 仅管理员可指定
普通用户上传的题目包若带了 `manifest.number`，导入会被 **400 拒绝**（避免"以为更新、实则新建"）；题号由系统自动分配。管理员提供 `number` 时按 `(type, number)` 幂等更新既有题目。
:::

## 进阶

- 自定义 evaluator 的调用细节与可传递数据类型：[Evaluator SDK](evaluator-sdk.md) / [RPC 与可传递数据](rpc.md)
- 镜像白名单与双容器运行时：[评测镜像与运行时](runtimes.md)
- 发布前质量要求：[题目质量规范](../standards/quality.md)
