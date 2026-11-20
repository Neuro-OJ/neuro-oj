# 快速出一题

> 本页是出题人的端到端路径：从设计题面到第一道题上线，共 5 步。

## 出题模型速览

与传统 OJ「准备输入输出文件」不同，Neuro OJ 需要你编写一个
**evaluator**（`evaluate.py`）：它在独立的 Evaluator
容器中运行，加载用户提交的函数并调用评分；用户代码运行在另一个无网的 Solution
容器中。核心概念见[评测模型](../mechanisms/judge-model.md)。

```text
你编写：evaluate.py（评分逻辑）+ 测试数据 + 题面
用户提交：实现题面声明的函数（如 solve(input_str) -> str）
评测：Evaluator 调用 Solution 中的函数，按返回值判分
```

## 步骤

1. **设计题目**：确定题面、函数签名与评分规则（例如
   `solve(input_str) -> str`，按返回值判分）。可参考[A+B 示例题](ab-example.md)。

2. **创建题目**：二选一。
   - **已有完整题目包**（含 `problem.json` 与
     `evaluate.py`）：在「新建题目」页选择「从题目包导入」（管理后台为「题目」→「导入题目包」），上传
     zip 即建题，题面与评测配置全部取自包内；也可以在命令行执行
     `noj-cli problem push <目录|zip> --server <平台地址> --domain school`。导入后进入编辑页核对并发布。
   - **从表单开始**：在「新建题目」填写标题、描述（Markdown）、难度、题型与标签，并配置运行时限制（Evaluator
     / Solution
     的时间与内存）；创建后自动进入该题编辑页，在那里上传支持包。见[Web 题目编辑器](web-editor.md)。

::: info 先选择工作空间 创建入口为
`/d/:slug/problems/new`，账号需要该域的题目创建权限。题目使用域内数字编号，不再区分
P/U。展示范围可选域成员或域内公开题库；域管理员不能授予平台敏感评测字段权限。
:::

3. **编写评测内容**：在本地编写 `evaluate.py`
   与测试数据。测试数据格式**完全自由**（`visible.jsonl` / `hidden.jsonl` /
   SQLite / CSV 均可），只要 evaluator
   能读取。见[测试数据与样例规范](../standards/test-data.md)。

4. **打包上传**：将题面、`evaluate.py` 与测试数据整理为统一题目包
   zip（`noj-cli problem lint` 校验、`noj-cli problem pack`
   打包），在编辑页「题目支持包」处上传；未发布的新题同样可以上传。包结构与
   manifest 要求见[题目包格式规范](../standards/problem-bundle.md)。

5. **自测发布**：
   1. 用一版参考答案提交，确认状态与得分符合预期。
   2. 检查隐藏用例的可见性（由 evaluator 控制）。
   3. 修改后重新上传，或对旧提交触发 rejudge（管理端）。

::: tip 提供初始代码模板 题目源码目录可提供初始代码模板（`problem.json` 的
`template` 字段，缺省
`template.py`）。**模板文件会随题目包一起上传**，导入时由平台读取并落库；编辑器在无本地草稿或点击「重置模板」时，通过
`GET /api/v1/domains/:slug/problems/:reference/template` 取回并填入代码框（返回
`{"data":{"content","language"}}`，题目没有模板则 404）。

所以：打包时不要删掉 `template.py`（`noj-cli problem pack` 与 `problems:build`
都会把它打进包），否则选手打开编辑器时不会看到初始代码。

注意：这是**代码编辑器的初始代码（starter
code）**，**不是**支持包模板下载；支持包需自行按[题目包格式规范](../standards/problem-bundle.md)组织后上传。
:::

::: warning 指定题号表示在目标域定位 不指定 `number`
时原子分配域内编号；指定后按 `(domain_id, number)`
定位。更新已有题目必须携带当前草稿 revision，缺少返回 428、过时返回
409。新建导入页和 `problem push`
不代替编辑者确认已有题目的更新；更新时请使用该题编辑页。 :::

## 进阶

- 自定义 evaluator
  的调用细节与可传递数据类型：[Evaluator SDK](../mechanisms/evaluator-sdk.md) /
  [RPC 与可传递数据](../mechanisms/rpc.md)
- 镜像白名单与双容器运行时：[评测镜像与运行时](../mechanisms/runtimes.md)
- 发布前质量要求：[题目质量规范](../standards/quality.md)
