# Solution SDK

Solution SDK 运行在 Solution 容器中。用户主要通过定义函数供 evaluator 调用；Solution Host 会自动加载用户模块并注册其中的顶层函数。

## 暴露函数

题面会声明必须实现的函数。例如：

```python
def solve(a: int, b: int) -> int:
    return a + b
```

Evaluator 会通过函数名调用该函数。函数名、参数数量和返回值语义由题目定义。

用户代码由 Judge Worker 以硬编码名 `main.py` 注入容器，Solution Host 通过 `--entry /workspace/main.py` 加载，模块名固定为 `user_solution`。出题人无需、也不能配置入口文件名。

## 顶层代码

Solution Host 会导入用户的 `main.py`。因此顶层代码会在加载模块时执行。

建议用户只在顶层定义函数和常量，避免执行耗时逻辑、读写外部资源或提前输出大量内容。

## stdout 和 stderr

用户代码中的 `print()` 不是答案输出。当前实现中，普通 `print()` 会写到 Solution 的 stdout，由于 stdout 是 NDJSON 协议通道，这些非协议文本会被 Judge Worker 丢弃，不会作为评测输出展示。因此不要把调试信息依赖在 `print()` 上。

下面的提交不会被当作 A+B 的正确答案：

```python
print(3)
```

A+B 题需要实现函数：

```python
def solve(input_str: str) -> str:
    a, b = map(int, input_str.split())
    return str(a + b)
```

## 常见错误语义

- 函数不存在：Evaluator 收到 `NotFoundError`（协议 code 为 `NotFound`）。
- 用户函数抛异常：Solution Host 返回 `code="Exception"`，Evaluator 收到 `SystemError`（含清洗后的 traceback）。
- 返回值类型非法：Solution Host 返回 `code="Rejected"`，Evaluator 收到 `RejectedError`。

用户函数的参数和返回值会经过 Neuro OJ codec 编码。支持的类型包括 `None`、布尔值、整数、有限浮点数、字符串、字节串、列表和字符串键字典（不支持 `tuple`/`set`）。更多限制见 [RPC 与可传递数据](rpc.md)。

## `noj_solution_sdk`

当题目声明了 capability（如外部网络 API）时，可以在注册函数内调用：

```python
from noj_solution_sdk import call_capability

def solve(prompt: str) -> str:
    return call_capability("request_llm_completion", prompt)
```

`call_capability(name, *args)` 把请求经 judge 转发到 Evaluator 执行，返回解码后的结果。能力名称、参数与返回值语义由题面声明。

- **RPC 方向**：Evaluator 主动调用 Solution（`runner.call()`）；Solution 通过 `call_capability` 反向调用 Evaluator 注册的能力（如网络请求）。Solution 不能读取 evaluator 的文件或隐藏用例数据。
- **类型约束**：`call_capability` 的参数与返回值与 `runner.call()` **相同**：只允许 `None / bool / int / float / str / bytes / list / dict`，不可序列化的对象会被拒绝。
- **错误**：未注册的 capability 抛 `CapabilityNotFoundError`；参数/返回值类型非法抛 `CapabilityRejectedError`；handler 异常抛 `CapabilityError`（含 `code` 与清洗后 trace）；通道断开抛 `CapabilityConnectionError`。
- **安全**：Solution 容器始终无网；capability 由出题人显式注册并负责参数校验（见 [如何提供受限网络能力](capability-networking.md)）。

普通不需要网络的题目无需导入该 SDK。
