# 评测模型

NOJ 当前支持双容器评测模型。每次提交会同时涉及 Evaluator 容器和 Solution 容器。

```text
提交代码
  |
  v
Solution 容器
  - solution.py
  - noj_solution_sdk
  - Solution Host 加载用户模块
  - 等待 Evaluator 调用函数
  |
  | runner.call(...)
  v
Evaluator 容器
  - evaluate.py
  - 测试数据或其他支持文件
  - noj_evaluator_sdk
  - 按题目自己的方式读取数据
  - 调用用户函数
  - 给出状态、分数和详情
```

## 与传统 OJ 的差异

传统 OJ 通常运行用户程序，把 stdin 输入喂给程序，再比对 stdout。NOJ 的 Python 题目不使用这种答案通道。

在 NOJ 中：

- 用户提交的是可被调用的 Python 代码。
- 题面会声明必须实现的函数，例如 `solve(a, b)`。
- `evaluate.py` 按题目自己的方式读取测试数据或生成测试输入，调用用户函数，并决定是否通过。
- 用户代码的 `print()` 是调试输出，不是答案输出。

## Evaluator 容器

Evaluator 容器运行出题人提供的 `evaluate.py`。它能读取支持包中的测试数据和辅助文件，也可以自行生成测试输入或调用本地辅助逻辑，并通过 `noj_evaluator_sdk` 调用 Solution。

Evaluator 是评分逻辑的所有者。它决定：

- 调用哪个函数。
- 给函数传什么参数。
- 如何比较返回值。
- 如何计算分数。
- 向用户展示哪些详情。

Evaluator 的 stdout 会进入评测输出。Evaluator 的 stderr 中，带有 `__NOJ_RPC__` 前缀的行会被 Judge Worker 识别为内部 RPC 帧，其余 stderr 会保留为评测输出的一部分。

## Solution 容器

Solution 容器运行用户提交的 `solution.py` 和 Solution Host。Solution Host 会加载用户模块，并等待 Evaluator 发起函数调用。

如果用户函数不存在，Solution Host 会返回 `FunctionNotFound`。如果用户函数抛异常，会返回异常类型、消息和截断后的 traceback。

注意这里的“返回”指的是发回给 Evaluator 的调用错误对象，不等于最终提交 verdict。最终显示给做题人的 `Accepted`、`WrongAnswer`、`RuntimeError` 等状态，仍然由 `evaluate.py` 决定。也就是说：

- 用户函数抛异常后，Evaluator 可以把它记成 `WrongAnswer`。
- 调用超时或调用阶段资源异常后，Evaluator 也可以把它当作普通失败样例处理，最终给出 `WrongAnswer`。
- 只有当 Evaluator 自己显式返回 `runtime_error()`，或 Judge Worker / Solution Host 在调用前就无法正常工作时，才更可能看到 `RuntimeError` / `SystemError`。
- 用户代码语法错误、模块导入失败、Solution Host 启动失败，通常会在调用前被判为 `SystemError`，因为这时 Evaluator 还没有拿到可继续评分的函数实例。

Solution Host 在同一次评测中是 persistent 的：多次 `runner.call()` 默认会调用同一个 Python 模块实例，因此用户模块的全局状态会在调用之间保留。Evaluator 可以通过 `runner.restart()` 请求重启 Solution Host，但普通题目通常不需要这样做。

用户代码的 stdout 会被重定向到 stderr。这保证用户的 `print()` 不会污染 Solution Host 的协议 stdout。最终 Solution stderr 会附加到评测输出中，便于调试。

## 隔离边界

Solution 不应直接读取隐藏测试数据。隐藏数据或评分材料位于 Evaluator 支持包中，或由 Evaluator 在运行时生成，由 Evaluator 控制使用方式。

网络、内存、时间和进程数限制由 Judge Worker 和运行时配置控制。出题人应避免在 evaluator 中泄露隐藏用例内容。

## 调用链路

一次 `runner.call("solve", 1, 2)` 的链路是：

```text
evaluate.py
  |
  | 1. Evaluator SDK 写出 __NOJ_RPC__ 请求帧到 evaluator stderr
  v
noj-judge
  |
  | 2. Judge Worker 截获 RPC 帧，转发到 Solution Host stdin
  v
Solution Host
  |
  | 3. 调用 solution.py 中的 solve(1, 2)
  v
noj-judge
  |
  | 4. Judge Worker 把响应 JSON 写回 evaluator stdin
  v
evaluate.py
  |
  | 5. runner.call() 返回结果或抛出 SolutionCallError
  v
评分逻辑
```

出题人正常情况下只使用 `SolutionRunner`，不需要手写 RPC 帧。RPC 细节见 [RPC 与可传递数据](rpc.md)。
