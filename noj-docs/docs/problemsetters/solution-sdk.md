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

用户函数的参数和返回值会经过 NOJ codec 编码。支持的类型包括 `None`、布尔值、整数、有限浮点数、字符串、字节串、列表、元组和字符串键字典。更多限制见 [RPC 与可传递数据](rpc.md)。

## `noj_solution_sdk`

当前 `noj_solution_sdk` 仅提供占位能力：

```python
from noj_solution_sdk import call_capability
```

`call_capability()` 在第一阶段不支持 Solution 到 Evaluator 的能力调用，会抛出 `UnsupportedCapability`。普通题目不需要导入该 SDK。

这也意味着当前 RPC 方向是 Evaluator 主动调用 Solution；Solution 不能主动读取 evaluator 的能力、文件或隐藏数据。
