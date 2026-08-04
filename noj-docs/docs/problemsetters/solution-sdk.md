# Solution SDK

Solution SDK 运行在 Solution 容器中。首阶段提供的能力很少，用户主要通过定义函数供 evaluator 调用。

## 暴露函数

题面会声明必须实现的函数。例如：

```python
def solve(a: int, b: int) -> int:
    return a + b
```

Evaluator 会通过函数名调用该函数。函数名、参数数量和返回值语义由题目定义。

## 顶层代码

Solution Host 会导入用户的 `solution.py`。因此顶层代码会在加载模块时执行。

建议用户只在顶层定义函数和常量，避免执行耗时逻辑、读写外部资源或提前输出大量内容。

## stdout 和 stderr

用户代码中的 `print()` 会被重定向到 stderr。它可以作为调试信息，但不是答案输出。

这意味着下面的提交不会被当作 A+B 的正确答案：

```python
print(3)
```

A+B 题需要实现函数：

```python
def solve(a: int, b: int) -> int:
    return a + b
```

## 常见错误语义

- `FunctionNotFound`：evaluator 调用的函数不存在。
- `NotCallable`：同名对象存在，但不是函数或其他可调用对象。
- 用户异常：返回异常类型、消息和截断后的 traceback。
- 返回值错误：通常由 evaluator 判定为 `WrongAnswer`。

用户函数的参数和返回值会经过 Neuro OJ codec 编码。支持的类型包括 `None`、布尔值、整数、有限浮点数、字符串、字节串、列表、元组和字符串键字典。更多限制见 [RPC 与可传递数据](rpc.md)。

## `noj_solution_sdk`

当题目声明了 capability（如外部网络 API）时，可以在注册函数内调用：

```python
from noj_solution_sdk import call_capability

def solve(prompt: str) -> str:
    return call_capability("request_llm_completion", prompt)
```

`call_capability(name, *args)` 把请求经 judge 转发到 Evaluator 执行，返回解码后的结果。能力名称、参数与返回值语义由题面声明。

- **RPC 方向**：Evaluator 主动调用 Solution（`runner.call()`）；Solution 通过 `call_capability` 反向调用 Evaluator 注册的能力（如网络请求）。Solution 不能读取 evaluator 的文件或隐藏用例数据。
- **类型约束**：`call_capability` 的参数与返回值与 `runner.call()` **相同**：只允许 `None / bool / int / float / str / bytes / list / dict`，不可序列化的对象会被拒绝，不会进入 RPC 帧。
- **错误**：未注册的 capability 抛 `CapabilityNotFoundError`；参数/返回值类型非法抛 `CapabilityRejectedError`；handler 异常抛 `CapabilityError`（含 `code` 与清洗后 trace）。
- **安全**：Solution 容器始终无网；capability 由出题人显式注册并负责参数校验（见 [如何提供受限网络能力](capability-networking.md)）。

普通不需要网络的题目无需导入该 SDK。
