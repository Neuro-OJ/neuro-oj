# 评测模型

Neuro OJ 当前支持双容器评测模型。每次提交会同时涉及 Evaluator 容器和 Solution 容器。核心术语见[术语表](../reference/glossary.md)。

```mermaid
flowchart TD
    A[提交代码] --> B["Solution 容器<br/>main.py<br/>noj_solution_sdk<br/>Solution Host 加载用户模块<br/>等待 Evaluator 调用函数"]
    B -->|runner.call| C["Evaluator 容器<br/>evaluate.py<br/>测试数据或其他支持文件<br/>noj_evaluator_sdk<br/>按题目自己的方式读取数据<br/>调用用户函数<br/>给出状态、分数和详情"]
```

## 与传统 OJ 的差异

传统 OJ 通常运行用户程序，把 stdin 输入喂给程序，再比对 stdout。Neuro OJ 的 Python 题目不使用这种答案通道。

在 Neuro OJ 中：

- 用户提交的是可被调用的 Python 代码。
- 题面会声明必须实现的函数，例如 `solve(a, b)`。
- `evaluate.py` 按题目自己的方式读取测试数据或生成测试输入，调用用户函数，并决定是否通过。
- 用户代码的 `print()` 不是答案输出；当前实现中普通 `print()` 写到 Solution stdout 会被协议层丢弃，不应依赖它作为调试回传通道。

## Evaluator 容器

Evaluator 容器运行出题人提供的 `evaluate.py`。它能读取纯净评测包中的测试数据和辅助文件，也可以自行生成测试输入或调用本地辅助逻辑，并通过 `noj_evaluator_sdk` 调用 Solution。

Evaluator 是评分逻辑的所有者。它决定：

- 调用哪个函数。
- 给函数传什么参数。
- 如何比较返回值。
- 如何计算分数。
- 向用户展示哪些详情。

Evaluator 的 stdout 会进入评测输出，同时承载 NDJSON 协议帧和 `---RESULT---` 标记；Judge Worker 解析带 `type` 字段的协议帧，其余文本作为评测输出。Evaluator 的 stderr 只作为普通日志/诊断输出，不承载 RPC 帧。

## Solution 容器

Solution 容器运行用户提交的代码（Judge Worker 以硬编码名 `main.py` 注入）和 Solution Host。Solution Host 会加载用户模块，并等待 Evaluator 发起函数调用。

如果用户函数不存在，Solution Host 会返回 `code="NotFound"` 的错误帧，Evaluator SDK 将其转换为 `NotFoundError`。如果用户函数抛异常，会返回异常类型、消息和截断后的 traceback。

注意这里的“返回”指的是发回给 Evaluator 的调用错误对象，不等于最终提交的结果状态（verdict）。最终显示给做题人的 `Accepted`、`WrongAnswer`、`RuntimeError` 等状态，仍然由 `evaluate.py` 决定。也就是说：

- 用户函数抛异常后，Evaluator 可以把它记成 `WrongAnswer`。
- 调用超时或调用阶段资源异常后，Evaluator 也可以把它当作普通失败用例处理，最终给出 `WrongAnswer`。
- 只有当 Evaluator 自己显式返回 `runtime_error()`，或 Judge Worker / Solution Host 在调用前就无法正常工作时，才更可能看到 `RuntimeError` / `SystemError`。
- 用户代码语法错误、模块导入失败、Solution Host 启动失败，通常会在调用前被判为 `SystemError`，因为这时 Evaluator 还没有拿到可继续评分的函数实例。

### 超时与状态映射

两层超时的最终状态映射：

| 超时来源 | 触发 | 最终状态 |
| --- | --- | --- |
| evaluator 整体执行超时 | 评测总时长超过 `time_limit_ms` | `SystemError`（Judge Worker 强制终止，做题人不可通过改代码解决） |
| 单次调用超时且 evaluator 未捕获 | 调用超过 `call_timeout_ms`，evaluate.py 异常退出、无 `---RESULT---` | `TimeLimitExceeded` |
| 单次调用超时且 evaluator 捕获 | 同上，但 evaluator 记为失败用例 | 由 evaluator 决定（如 `WrongAnswer`） |
| evaluator 异常退出且从未发生调用超时 | evaluate.py 自身 bug、环境问题、无 `---RESULT---` | `SystemError` |

evaluator 启动超时（评测环境未就绪）同样归 `SystemError`。

Solution Host 在同一次评测中是 persistent 的：多次 `runner.call()` 默认会调用同一个 Python 模块实例，因此用户模块的全局状态会在调用之间保留。当前 SDK **不提供** `runner.restart()`。

## 隔离边界

Solution 不应直接读取隐藏用例。隐藏用例的数据位于 Evaluator 读取的纯净评测包中，或由 Evaluator 在运行时生成，由 Evaluator 控制使用方式。

网络、内存、时间和进程数限制由 Judge Worker 和运行时配置控制。出题人应避免在 evaluator 中泄露隐藏用例内容。

## 调用链路

一次 `runner.call("solve", 1, 2)` 的链路是：

```mermaid
sequenceDiagram
    participant E as evaluate.py
    participant J as noj-judge
    participant S as Solution Host
    E->>J: 1. 写 NDJSON call 帧（evaluator stdout）
    J->>S: 2. 解析并转发到 Solution Host stdin
    S->>S: 3. 调用 main.py 中的 solve(1, 2)
    J-->>E: 4. 把响应帧写回 evaluator stdin
    E->>E: 5. runner.call() 返回结果或抛出对应异常，进入评分逻辑
```

出题人正常情况下只使用 `SolutionRunner`，不需要手写 RPC 帧。RPC 细节见 [RPC 与可传递数据](rpc.md)。
